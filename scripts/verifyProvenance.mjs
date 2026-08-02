/**
 * clean checkout から profile を生成して、provenance が正しく出るか実際に確かめる。
 *   npm run verify:provenance
 *
 * ## なぜテストスイートに入れないか
 *
 * 受入試験 7 項目のうち 6 項目は `test/provenance.test.ts` にある。
 * **項目 1（clean checkout から生成）だけは、開発中は必ず落ちる。**
 * 入力を直している最中は作業ツリーが汚れているので、
 * 「clean なら dirty=false」を実物で確かめられるのはコミット後だけになる。
 *
 * 作業ツリーの状態でテストの成否が変わるものをスイートに入れると、
 * 「落ちていても気にしない」テストが 1 つ生まれる。それは空振りと同じくらい悪い
 * (→ CONTRIBUTING §7)。だから**別コマンドにして、release の前に回す**。
 *
 * ## 何をするか
 *
 *   1. HEAD から一時的な worktree を作る (clean な checkout)
 *   2. node_modules を symlink する (npm ci を待たないため)
 *   3. そこで exporter を --release 付きで走らせる
 *   4. workingTreeDirty=false / artifactKind=release になることを確かめる
 *   5. worktree を片付ける
 *
 * **リポジトリ本体には触らない。** 生成物も worktree の中にしか書かない。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = process.cwd()
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const wt = mkdtempSync(join(tmpdir(), 'trs-clean-'))
let ok = false
try {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).trim()
  console.log(`  HEAD ${head.slice(0, 12)} から clean な checkout を作る`)
  run('git', ['worktree', 'add', '--detach', wt, head], { cwd: ROOT })

  // node_modules は共有する (npm ci を待たない)。生成物は worktree の中にしか出ない
  symlinkSync(resolve(ROOT, 'node_modules'), join(wt, 'node_modules'), 'dir')

  const out = run('npx', ['vite-node', 'scripts/exportHalfPlugProfile.ts', '--variant', 'TRS|JACK-TRS', '--release'], {
    cwd: wt,
    env: { ...process.env, ARTIFACT_DATE: '2026-08-03' },
  })
  console.log(out.split('\n').filter((l) => l.trim()).map((l) => `  ${l.trim()}`).join('\n'))

  const p = JSON.parse(
    readFileSync(join(wt, 'artifacts/half_plug_topology_profile.v2.trs_jack_trs.json'), 'utf8'),
  ).provenance

  // **HEAD の生成器で走っている。** provenance を足した変更をまだコミットしていなければ、
  // ここには何も入らない。TypeError で落ちると原因が分からないので、名指しで言う
  if (!p) {
    console.log('\n  ✗ HEAD の生成器が provenance を出力していない。')
    console.log('    この確認は **HEAD の内容**で走る（それが clean checkout の意味）。')
    console.log('    provenance を足した変更をコミットしてから、もう一度実行する。')
    process.exit(1)
  }

  const checks = [
    ['workingTreeDirty が false', p.workingTreeDirty === false],
    ['artifactKind が release', p.artifactKind === 'release'],
    ['generatedFromCommit が HEAD と一致', p.generatedFromCommit === head],
    ['revisionOverride が false', p.revisionOverride === false],
    ['inputDigest が 64 桁の hex', /^[0-9a-f]{64}$/.test(p.inputDigest)],
    ['inputFiles が 10 件以上', p.inputFiles.length >= 10],
    [
      '生成物自身が入力に入っていない',
      !p.inputFiles.some((f) => f.path.includes('half_plug_topology_profile')),
    ],
  ]
  console.log()
  for (const [what, pass] of checks) console.log(`  ${pass ? '✓' : '✗'} ${what}`)
  ok = checks.every(([, pass]) => pass)

  // 手元の committed artifact との比較。**一致は要求しない。**
  // 手元は開発中に生成しているので workingTreeDirty=true が正しい
  const local = JSON.parse(
    readFileSync(resolve(ROOT, 'artifacts/half_plug_topology_profile.v2.trs_jack_trs.json'), 'utf8'),
  ).provenance
  console.log(
    `\n  コミット済み artifact: dirty=${local.workingTreeDirty} / ${local.artifactKind}`
      + ` / digest ${local.inputDigest.slice(0, 12)}`,
  )
  console.log(`  clean checkout      : dirty=${p.workingTreeDirty} / ${p.artifactKind} / digest ${p.inputDigest.slice(0, 12)}`)

  // **「入力が汚れている」と「artifact が古い」を取り違えないこと。**
  // 2026-08-03 の通し確認で、clean な worktree なのに
  // 「手元に未コミットの入力変更がある（開発中は正常）」と表示し、
  // **古い artifact を正常扱いして exit 0 で終えていた。**
  // clean checkout で digest が食い違うなら、原因は未コミット変更ではなく
  // コミット済み artifact が古いことしかありえない。
  if (local.inputDigest !== p.inputDigest) {
    console.log('\n  ✗ コミット済み artifact の inputDigest が、現在の入力と食い違っている。')
    console.log('    clean な checkout で作り直しても違うので、**artifact のほうが古い。**')
    console.log('    npm run export:half-plug:all で作り直してコミットする。')
    ok = false
  } else {
    console.log('  → digest が一致。コミット済み artifact は現在の入力から作られている')
  }
  if (local.workingTreeDirty) {
    console.log('\n  ⚠ コミット済み artifact が workingTreeDirty: true を記録している。')
    console.log('    未コミットの入力があった状態で生成されたもので、その入力は再現できない。')
    console.log('    release の前に、clean な状態で作り直すこと。')
  }
} finally {
  try {
    run('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT })
  } catch {
    rmSync(wt, { recursive: true, force: true })
  }
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true })
  run('git', ['worktree', 'prune'], { cwd: ROOT })
}

console.log(ok ? '\nclean checkout からの生成を確認しました。' : '\n**確認に失敗しました。**')
process.exit(ok ? 0 : 1)
