import path from 'node:path';

const marker = 'COPILOT_REAL_APPROVED';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, allowed) => isRecord(value) && Object.keys(value).every(key => allowed.includes(key));
const expectedText = value => [marker, marker + '\n', marker + '\n\n'].includes(value);

/** Narrow synthetic live-test policy, NOT a filesystem/OS sandbox. Unknown shapes deny. */
export function isSafeProbeWrite(toolCall, { root, fileExists } = {}) {
  if (fileExists !== false || typeof root !== 'string' || !path.isAbsolute(root)) return false;
  const target = path.join(root, 'approved-real.txt');
  if (!onlyKeys(toolCall, ['toolCallId', 'title', 'kind', 'status', 'rawInput', 'locations', 'content'])) return false;
  if (!['edit', 'create', 'write'].includes(toolCall.kind)) return false;
  const input = toolCall.rawInput;
  if (!isRecord(input) || input.fileName !== target) return false;
  if (!Array.isArray(toolCall.locations) || toolCall.locations.length === 0) return false;
  if (!toolCall.locations.every(location => onlyKeys(location, ['path', 'line']) && location.path === target &&
    (!Object.hasOwn(location, 'line') || Number.isInteger(location.line) && location.line >= 0))) return false;
  if (Object.hasOwn(input, 'diff')) {
    // Exact observed native create format, not a general patch parser. Any extra operation denies.
    const expectedDiff = `\ndiff --git a${target} b${target}\ncreate file mode 100644\nindex 0000000..0000000\n--- a/dev/null\n+++ b${target}\n@@ -1,0 +1,2 @@\n+${marker}\n+\n\n`;
    return onlyKeys(input, ['fileName', 'diff']) && !Object.hasOwn(toolCall, 'content') && input.diff === expectedDiff;
  }
  if (!onlyKeys(input, ['fileName', 'content'])) return false;
  if (Object.hasOwn(input, 'content') && !expectedText(input.content)) return false;
  if (!Array.isArray(toolCall.content) || toolCall.content.length !== 1) return false;
  const diff = toolCall.content[0];
  return onlyKeys(diff, ['type', 'path', 'oldText', 'newText']) && diff.type === 'diff' && diff.path === target &&
    (diff.oldText === '' || diff.oldText === null) && expectedText(diff.newText);
}
