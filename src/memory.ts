// LanceDB 记忆库，两张表：
// profiles —— 人和群的长期画像，按 group_id / user_id / type 精确过滤读取，不做向量检索（这层是"常识"）。
// events   —— 发生过的事情，带 embedding，按向量检索取最相关的少量（这层才是 RAG）。
// 原生依赖装不上、目录不可写等情况下整体降级成"没有长期记忆"，绝不影响正常聊天。
import { log } from './logger.ts';

export type Evidence = 'self_statement' | 'observed_event' | 'third_party_claim' | 'inference';

export type ProfileRow = {
  id: string;
  group_id: string;          // 记忆所属会话范围：群号或 private:<QQ号>；空串表示通用
  user_id: string;           // 画像主体；空串表示这是"群"的画像
  user_name: string;         // 昵称，仅用于注入时显示
  type: string;              // identity / interest / state / relation / meme
  content: string;
  evidence: Evidence;
  confidence: number;
  created_at: number;
  updated_at: number;
  source_message_ids: string; // 逗号分隔的消息 ID，用于追溯
};

export type EventRow = {
  id: string;
  group_id: string;
  subject_user_id: string;
  participants: string;       // 逗号分隔
  type: string;               // event / state_change / claim
  content: string;
  importance: number;
  confidence: number;
  evidence: Evidence;
  created_at: number;
  updated_at: number;
  source_message_ids: string;
  embedding: number[];
};

export type EventHit = EventRow & { _distance?: number };

const env = process.env;
export const memoryDir = env.MEMORY_DIR || 'data/memory';
export const memoryEnabled = () => env.MEMORY_ENABLED !== '0';

// LanceDB 的 where 子句是字符串，值必须转义，避免昵称里的引号把查询搞坏。
const quote = (value: string) => `'${String(value).replace(/'/g, "''")}'`;
const scopeOf = (scope: string) => `group_id = ${quote(scope)}`;

let connecting: Promise<any> | undefined;
let unavailable: string | undefined;

/** 连接失败只记一次，之后静默降级；失败信息留在 unavailable 里供日志和排查。 */
async function db(): Promise<any | undefined> {
  if (!memoryEnabled()) return undefined;
  if (unavailable) return undefined;
  connecting ??= import('@lancedb/lancedb')
    .then(lancedb => lancedb.connect(memoryDir))
    .catch((error: any) => {
      unavailable = error?.message ?? String(error);
      log('记忆库不可用，长期记忆已关闭', { dir: memoryDir, error: unavailable });
      return undefined;
    });
  return await connecting;
}

async function has(database: any, name: string): Promise<boolean> {
  return (await database.tableNames()).includes(name);
}

/** 插入：表不存在就用这批数据建表（LanceDB 按第一批数据推断 schema）。 */
async function insert(name: string, rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  const database = await db();
  if (!database) return 0;
  if (!(await has(database, name))) {
    await database.createTable(name, rows);
    return rows.length;
  }
  try {
    await (await database.openTable(name)).add(rows);
  } catch (error: any) {
    // 换了 embedding 模型导致维度对不上时，给出可操作的提示。
    if (/schema|dimension|type|cast/i.test(error?.message ?? '')) {
      log('记忆写入失败：表结构不匹配，换过 embedding 模型就清空 MEMORY_DIR 重建', { table: name, error: error.message });
    }
    throw error;
  }
  return rows.length;
}

async function select(name: string, where: string, limit: number): Promise<any[]> {
  const database = await db();
  if (!database || !(await has(database, name))) return [];
  return await (await database.openTable(name)).query().where(where).limit(limit).toArray();
}

async function update(name: string, id: string, values: Record<string, any>): Promise<boolean> {
  const database = await db();
  if (!database || !(await has(database, name))) return false;
  await (await database.openTable(name)).update({ where: `id = ${quote(id)}`, values });
  return true;
}

async function remove(name: string, id: string): Promise<boolean> {
  const database = await db();
  if (!database || !(await has(database, name))) return false;
  await (await database.openTable(name)).delete(`id = ${quote(id)}`);
  return true;
}

// ---- profiles：精确过滤，向量不参与 ----

export const addProfiles = (rows: ProfileRow[]) => insert('profiles', rows);

/** 某个会话范围内、指定几个人的画像；userId 为空串时取"群画像"。 */
export async function listProfiles(scope: string, userIds: string[], limit = 40): Promise<ProfileRow[]> {
  const ids = userIds.length ? userIds : [''];
  const where = `${scopeOf(scope)} AND user_id IN (${ids.map(quote).join(', ')})`;
  const rows: ProfileRow[] = await select('profiles', where, Math.max(limit * 4, 200));
  return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

export const updateProfile = (id: string, values: Partial<ProfileRow>) => update('profiles', id, values);
export const deleteProfile = (id: string) => remove('profiles', id);

// ---- events：向量检索 ----

export const addEvents = (rows: EventRow[]) => insert('events', rows);

/** 按向量取最近的几条，distance 超过阈值的不返回（阈值过滤放在这里，调用方只会拿到相关的）。 */
export async function searchEvents(
  vector: number[],
  { scope, limit = 3, maxDistance = 0.5 }: { scope: string; limit?: number; maxDistance?: number },
): Promise<EventHit[]> {
  const database = await db();
  if (!database || !(await has(database, 'events'))) return [];
  const hits: EventHit[] = await (await database.openTable('events'))
    .search(vector).distanceType('cosine').where(scopeOf(scope)).limit(limit).toArray();
  return hits.filter(hit => Number(hit._distance ?? 1) <= maxDistance);
}

/** 没有 embedding 时的兜底：按主题人 + 范围取最近的几条，用于"判断是否重复"。 */
export async function recentEvents(scope: string, subjectUserIds: string[], limit = 5): Promise<EventRow[]> {
  const ids = subjectUserIds.filter(Boolean);
  if (!ids.length) return [];
  const where = `${scopeOf(scope)} AND subject_user_id IN (${ids.map(quote).join(', ')})`;
  const rows: EventRow[] = await select('events', where, 200);
  return rows.sort((a, b) => b.updated_at - a.updated_at).slice(0, limit);
}

export const updateEvent = (id: string, values: Partial<EventRow>) => update('events', id, values);
export const deleteEvent = (id: string) => remove('events', id);

export async function memoryStats() {
  const database = await db();
  if (!database) return { ready: false, dir: memoryDir, profiles: 0, events: 0, error: unavailable ?? '未启用' };
  const names = await database.tableNames();
  const count = async (name: string) => (names.includes(name) ? await (await database.openTable(name)).countRows() : 0);
  return { ready: true, dir: memoryDir, profiles: await count('profiles'), events: await count('events') };
}
