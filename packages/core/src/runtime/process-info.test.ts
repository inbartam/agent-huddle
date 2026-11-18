/**
 * The process command-line reader (orphan reconciliation): the parsers on recorded output shapes, and one live query
 * of a child this test starts (PowerShell CIM on Windows, `ps` elsewhere) to show the real reader sees `--session-id`.
 */
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePowerShellProcesses,
  parsePsList,
  parseWmicList,
  powerShellScript,
  readProcessCommandLines,
} from './process-info.js';
import { commandLineIsRun } from './orphans.js';

const RUN = '7d0c3f5e-2b1a-4c9d-8e7f-0a1b2c3d4e5f';

const children: { kill: () => void }[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

describe('parsers', () => {
  it('PowerShell JSON: an array, a single object, null command lines, and anything else is null', () => {
    expect(
      parsePowerShellProcesses(
        '[{"ProcessId":10,"CommandLine":"\\"C:\\\\x\\\\claude.exe\\" -p --session-id ' +
          RUN +
          '"},{"ProcessId":11,"CommandLine":null}]',
      ),
    ).toEqual(
      new Map<number, string | null>([
        [10, `"C:\\x\\claude.exe" -p --session-id ${RUN}`],
        [11, null],
      ]),
    );
    expect(parsePowerShellProcesses('{"ProcessId":12,"CommandLine":"node a.js"}')).toEqual(
      new Map([[12, 'node a.js']]),
    );
    expect(parsePowerShellProcesses('[]')).toEqual(new Map());
    expect(parsePowerShellProcesses('')).toBeNull();
    expect(parsePowerShellProcesses('Get-CimInstance : Access denied')).toBeNull();
    expect(parsePowerShellProcesses('[{"ProcessId":"x"}]')).toBeNull();
  });

  it('wmic /format:list (CR CR LF), and no instance', () => {
    const text = `\r\r\n\r\r\nCommandLine=claude.exe -p --session-id ${RUN}\r\r\nProcessId=4242\r\r\n\r\r\n\r\r\n`;
    expect(parseWmicList(text)).toEqual(new Map([[4242, `claude.exe -p --session-id ${RUN}`]]));
    expect(parseWmicList('CommandLine=\r\r\nProcessId=7\r\r\n')).toEqual(new Map([[7, null]]));
    expect(parseWmicList('')).toEqual(new Map());
  });

  it('ps -o pid=,args=', () => {
    expect(parsePsList(`  101 /usr/bin/claude -p --session-id ${RUN}\n  202 bash\n`)).toEqual(
      new Map([
        [101, `/usr/bin/claude -p --session-id ${RUN}`],
        [202, 'bash'],
      ]),
    );
  });

  it('the PowerShell script names only the checked pids', () => {
    expect(powerShellScript([12, 34])).toContain("-Filter 'ProcessId=12 OR ProcessId=34'");
  });
});

describe('readProcessCommandLines on this machine', () => {
  it(
    'sees a running child with its --session-id, and leaves out a pid that is not running',
    { timeout: 30_000 },
    async () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--session-id', RUN], {
        stdio: 'ignore',
        windowsHide: true,
      });
      children.push({ kill: () => child.kill() });
      const pid = child.pid ?? -1;
      expect(pid).toBeGreaterThan(0);
      // A pid that is not running: a child that has exited.
      const done = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      await new Promise((r) => done.once('exit', r));
      const gonePid = done.pid ?? -1;

      const lines = await readProcessCommandLines([pid, gonePid, -5]);
      expect(lines).not.toBeNull();
      expect(lines?.has(gonePid)).toBe(false);
      const line = lines?.get(pid) ?? '';
      expect(commandLineIsRun(line, RUN)).toBe(true);
      expect(commandLineIsRun(line, '00000000-0000-4000-8000-000000000000')).toBe(false);
      expect(await readProcessCommandLines([])).toEqual(new Map());
    },
  );
});
