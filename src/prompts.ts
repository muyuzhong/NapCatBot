// 提示词统一从 prompts/ 读取，代码里不放具体措辞；文件缺失时退回文件内的默认值。
import { existsSync, readFileSync } from 'node:fs';
import { log } from './logger.ts';

const dir = process.env.PROMPTS_DIR || 'prompts';

function load(name: string, fallback: string, vars: Record<string, string> = {}): string {
  const file = `${dir}/${name}`;
  let text = fallback;
  if (existsSync(file)) {
    const content = readFileSync(file, 'utf8').trim();
    if (content) text = content;
    else log('提示词文件为空，使用默认值', file);
  } else {
    log('提示词文件不存在，使用默认值', file);
  }
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => vars[key] ?? whole);
}

export const prompts = {
  dir,
  get system() { return load('system.txt', '你是一个中文聊天助手。'); },
  decide: (vars: Record<string, string>) => load('decide.txt', [
    '判断群聊机器人要不要参与这轮对话，只回答要不要回，不要写回复内容。',
    '最近的群聊：\n{{history}}\n当前这批消息：\n{{messages}}',
    '这批里只要有一条值得接就回 true，一条都没有回 false。',
    '只输出一个词：true 或 false。',
  ].join('\n'), vars),
  summary: (vars: Record<string, string>) => load('summary.txt', [
    '把下面这段较早的聊天记录压缩成一段中文摘要。',
    '保留说话人、约定、关键结论与未结束的话题；控制在 200 字以内。',
    '\n{{history}}',
  ].join('\n'), vars),
  memoryExtract: (vars: Record<string, string>) => load('memory-extract.txt', [
    '从这段聊天里挑出值得长期记住的人和事，只输出 JSON：{"memories":[]}',
    '会话范围：{{scope}}\n说话人：{{speakers}}\n聊天记录：\n{{segment}}',
  ].join('\n'), vars),
  memoryMerge: (vars: Record<string, string>) => load('memory-merge.txt', [
    '对每条候选决定 ADD / UPDATE / IGNORE，只输出 JSON：{"ops":[]}',
    '已有记忆：\n{{existing}}\n新候选：\n{{candidates}}',
  ].join('\n'), vars),
  memoryInject: (vars: Record<string, string>) => load('memory-inject.txt', [
    '[长期记忆] 下面是你本来就知道的背景，不是新消息；只在相关时自然使用，不要复述。',
    '{{profiles}}',
    '{{events}}',
  ].join('\n'), vars),
};
