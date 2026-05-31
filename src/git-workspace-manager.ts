import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from './logger';

const exec = promisify(execFile);

export interface ParkResult {
  parked: boolean;
  branch?: string;
  fileCount?: number;
  pushed?: boolean;
  refreshed: boolean;
  error?: string;
}

export interface WipBranch {
  name: string;
  subject: string;
  age: string;
}

export interface OpenPr {
  number: number;
  title: string;
  branch: string;
}

/**
 * Manages the shared git checkout that all Slack conversations operate on.
 * Because every thread shares one working directory, uncommitted work from a
 * previous thread can be silently lost on refresh. To prevent that, work is
 * "parked" onto an auto-named wip/ branch (and pushed) before refreshing.
 */
export class GitWorkspaceManager {
  private logger = new Logger('GitWorkspaceManager');

  private async git(dir: string, args: string[]): Promise<string> {
    const { stdout } = await exec('git', ['-C', dir, ...args], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  }

  /** A deterministic-ish timestamp slug for branch names (no Date.now reliance issues here). */
  private timestamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /**
   * If the repo has uncommitted changes or sits on an unpushed non-default
   * branch, commit everything to wip/auto-<ts>, push it, then return to the
   * default branch and fast-forward. Never destroys work.
   */
  async parkAndRefresh(dir: string, defaultBranch = 'master'): Promise<ParkResult> {
    try {
      // Is this even a git repo?
      await this.git(dir, ['rev-parse', '--is-inside-work-tree']);

      const status = await this.git(dir, ['status', '--porcelain']);
      const currentBranch = await this.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const dirty = status.length > 0;

      let parked = false;
      let branch: string | undefined;
      let fileCount: number | undefined;
      let pushed = false;

      if (dirty) {
        const files = status.split('\n').filter(Boolean);
        fileCount = files.length;
        branch = `wip/auto-${this.timestamp()}`;
        await this.git(dir, ['checkout', '-b', branch]);
        await this.git(dir, ['add', '-A']);
        await this.git(dir, [
          'commit',
          '-m',
          `wip: auto-parked uncommitted work (${fileCount} file(s)) from ${currentBranch}`,
          '--no-verify',
        ]);
        parked = true;
        try {
          await this.git(dir, ['push', '-u', 'origin', branch]);
          pushed = true;
        } catch (e) {
          this.logger.warn('Parked branch committed locally but push failed', { branch, error: String(e) });
        }
      }

      // Return to default branch and fast-forward to latest.
      let refreshed = false;
      try {
        await this.git(dir, ['checkout', defaultBranch]);
        await this.git(dir, ['fetch', 'origin', defaultBranch]);
        // Only fast-forward; never create merge commits on the shared checkout.
        await this.git(dir, ['merge', '--ff-only', `origin/${defaultBranch}`]);
        // Keep submodules in sync with the refreshed superproject.
        try {
          await this.git(dir, ['submodule', 'update', '--init', '--recursive']);
        } catch (e) {
          this.logger.warn('Submodule update failed after refresh', { error: String(e) });
        }
        refreshed = true;
      } catch (e) {
        this.logger.warn('Refresh (checkout/ff-merge) failed', { error: String(e) });
      }

      return { parked, branch, fileCount, pushed, refreshed };
    } catch (e) {
      this.logger.error('parkAndRefresh failed', e);
      return { parked: false, refreshed: false, error: String(e) };
    }
  }

  /** List wip/auto-* branches (local + remote) with their last-commit subject. */
  async listWipBranches(dir: string): Promise<WipBranch[]> {
    try {
      await this.git(dir, ['fetch', 'origin', '--prune']);
      const out = await this.git(dir, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)\t%(contents:subject)\t%(committerdate:relative)',
        'refs/heads/wip/',
        'refs/remotes/origin/wip/',
      ]);
      const seen = new Set<string>();
      const result: WipBranch[] = [];
      for (const line of out.split('\n').filter(Boolean)) {
        const [rawName, subject, age] = line.split('\t');
        const name = rawName.replace(/^origin\//, '');
        if (seen.has(name)) continue;
        seen.add(name);
        result.push({ name, subject: subject || '(no message)', age: age || '' });
      }
      return result;
    } catch (e) {
      this.logger.warn('listWipBranches failed', { error: String(e) });
      return [];
    }
  }

  /** List open PRs via the gh CLI (best-effort; returns [] if gh/auth absent). */
  async listOpenPrs(dir: string): Promise<OpenPr[]> {
    try {
      const { stdout } = await exec(
        'gh',
        ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName'],
        { cwd: dir, maxBuffer: 10 * 1024 * 1024 }
      );
      const arr = JSON.parse(stdout || '[]');
      return arr.map((p: any) => ({ number: p.number, title: p.title, branch: p.headRefName }));
    } catch (e) {
      this.logger.warn('listOpenPrs failed (gh missing/unauth?)', { error: String(e) });
      return [];
    }
  }

  /**
   * Build a human-readable summary of leftover work to surface at the start of
   * a conversation. Returns '' if there is nothing to report.
   */
  async buildWipSummary(dir: string, park: ParkResult): Promise<string> {
    const wip = await this.listWipBranches(dir);
    const prs = await this.listOpenPrs(dir);

    const lines: string[] = [];
    if (park.parked) {
      lines.push(
        `I found uncommitted work in the shared checkout from a previous session and parked it on \`${park.branch}\` (${park.fileCount} file(s))${park.pushed ? ' and pushed it to GitHub' : ' (local only — push failed, still on the box)'}.`
      );
    }
    if (wip.length > 0) {
      lines.push('', '*Parked WIP branches:*');
      for (const b of wip) lines.push(`• \`${b.name}\` — ${b.subject} (${b.age})`);
    }
    if (prs.length > 0) {
      lines.push('', '*Open pull requests:*');
      for (const p of prs) lines.push(`• #${p.number} ${p.title} (\`${p.branch}\`)`);
    }

    if (lines.length === 0) return '';

    return [
      'SYSTEM NOTE — leftover-work check (surface this to the user before doing anything else):',
      ...lines,
      '',
      'Briefly tell the user about the above and ask whether they want to resume any of it or continue on fresh master. Then proceed with their request.',
    ].join('\n');
  }
}
