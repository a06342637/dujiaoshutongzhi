import { GrammyError } from 'grammy';

export const TARGET_INPUT_HELP =
  '请发送频道或群组的用户名，直接填写 @ 后面的字母即可，例如 my_shop。\n也支持 @my_shop、https://t.me/my_shop 或数字 ID（如 -1001234567890）。\n先把机器人加入目标并设为管理员；频道还需允许发布消息。私有频道／群没有用户名，请使用数字 ID。';

export function normalizeTarget(input: string): string {
  let value = input.trim();
  if (/^-?[1-9]\d{0,19}$/.test(value)) return value;
  if (/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i.test(value)) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      parts.length !== 1 ||
      parts[0]!.startsWith('+') ||
      parts[0] === 'joinchat'
    )
      throw new Error(
        '请填写公开频道／群的用户名，不要使用邀请链接或消息链接；私有目标请填写数字 ID。',
      );
    value = parts[0]!;
  }
  const username = value.replace(/^@/, '');
  // Collectible Telegram usernames may be shorter than ordinary 5-character usernames.
  // Resolve existence through Telegram instead of rejecting valid short usernames locally.
  if (!/^[a-z][a-z0-9_]{0,31}$/i.test(username))
    throw new Error(
      '请输入频道／群的用户名（@ 后面的字母、数字和下划线），不是中文显示名称；也可以填写数字 ID。',
    );
  return `@${username}`;
}

export function targetError(error: unknown): Error {
  if (!(error instanceof GrammyError))
    return error instanceof Error ? error : new Error('目标连接失败，请稍后重试。');
  if (
    /chat not found|username.*(?:invalid|not occupied)|USERNAME_NOT_OCCUPIED/i.test(
      error.description,
    )
  )
    return new Error(
      '找不到该频道／群。请检查用户名是否正确，并确认机器人已加入目标；私有目标请使用数字 ID。',
    );
  if (/not.*member|kicked|forbidden/i.test(error.description))
    return new Error('机器人尚未加入目标或已被移除，请先拉入并设为管理员。');
  if (
    /USER_RIGHTS_MISSING|not enough rights|administrator|CHAT_ADMIN_REQUIRED/i.test(
      error.description,
    )
  )
    return new Error('权限不足：请将机器人设为频道／群管理员，频道还要允许发布消息，再重新绑定。');
  if (error.error_code === 429)
    return new Error(`Telegram 暂时限流，请等待 ${error.parameters.retry_after ?? 30} 秒后重试。`);
  return new Error(`检查通知目标失败：${error.description}`);
}
