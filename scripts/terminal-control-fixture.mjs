// Isolated test CLI, never runs a shell or contacts an AI provider.
import { writeFileSync } from 'node:fs';
const output = process.argv[2];
if (!output?.startsWith('/tmp/officeai-control-test.')) throw new Error('Private test directory required');
const events = [];
const save = () => writeFileSync(output, JSON.stringify({pid:process.pid, events}));
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[?2004hOfficeAI isolated CLI fixture — no provider calls\r\n');
save();
let input = '';
process.stdin.on('data', data => {
  if (data.includes('\x03')) { events.push({kind:'interrupt'}); input=''; save(); return; }
  input += data;
  // Kitty wraps each stdin chunk separately; adjacent paste boundaries are one draft.
  input = input.replaceAll('\x1b[201~\x1b[200~', '');
  const paste = input.match(/\x1b\[200~([\s\S]*?)\x1b\[201~[\r\n]/);
  if (paste) { events.push({kind:'prompt', message:paste[1]}); input=''; save(); }
});
