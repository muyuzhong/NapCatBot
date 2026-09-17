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
};
