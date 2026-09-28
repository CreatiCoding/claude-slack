import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renewIfNeeded, type RenewSteps } from '../src/cert-renew.ts'

const NOW = new Date('2026-12-01T00:00:00Z')
const at = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86400000)

/** Steps that record what was done. `disk` is the certificate's expiry, changed by `issue`. */
function steps(o: { disk?: Date; issued?: Date; issueFails?: boolean; uploadFails?: boolean; served?: Date | undefined } = {}) {
  const calls: string[] = []
  const sent: string[] = []
  let disk = o.disk
  const s: RenewSteps = {
    now: () => NOW,
    expiry: async () => disk,
    issue: async () => {
      calls.push('issue')
      if (o.issueFails) throw new Error('DNS problem: NXDOMAIN looking up TXT\nsecond line')
      disk = o.issued ?? at(90)
    },
    upload: async () => {
      calls.push('upload')
      if (o.uploadFails) throw new Error('certificates.create: 502')
    },
    served: async () => ('served' in o ? o.served : disk),
    notify: async (t) => void sent.push(t),
    log: () => {},
  }
  return { s, calls, sent }
}

test('만료까지 30일보다 많이 남았으면 아무것도 하지 않는다', async () => {
  const { s, calls, sent } = steps({ disk: at(45) })
  assert.equal(await renewIfNeeded(s), 'fresh')
  assert.deepEqual(calls, [])
  assert.deepEqual(sent, [], '조용히')
})

test('30일 이하로 남았으면 발급 → 업로드 → 실제 서비스 확인 순으로 하고, 성공을 알린다', async () => {
  const { s, calls, sent } = steps({ disk: at(20), issued: at(90) })
  assert.equal(await renewIfNeeded(s), 'renewed')
  assert.deepEqual(calls, ['issue', 'upload'])
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /갱신했습니다.*2027-03-01/)
})

test('인증서가 없으면 발급한다', async () => {
  const { s, calls } = steps({ disk: undefined })
  assert.equal(await renewIfNeeded(s), 'renewed')
  assert.deepEqual(calls, ['issue', 'upload'])
})

test('발급이 실패하면 업로드하지 않고, 남은 날짜와 원인과 직접 실행할 명령을 알린다', async () => {
  const { s, calls, sent } = steps({ disk: at(12), issueFails: true })
  assert.equal(await renewIfNeeded(s), 'failed')
  assert.deepEqual(calls, ['issue'], 'no upload after a failed issue')
  assert.match(sent[0]!, /12일 뒤 만료/)
  assert.match(sent[0]!, /NXDOMAIN/)
  assert.match(sent[0]!, /sh scripts\/issue-cert/)
})

test('발급이 끝났는데 파일이 새 것이 아니면 실패로 보고 업로드하지 않는다', async () => {
  const { s, calls, sent } = steps({ disk: at(10), issued: at(10) })
  assert.equal(await renewIfNeeded(s), 'failed')
  assert.deepEqual(calls, ['issue'])
  assert.match(sent[0]!, /새 것으로 바뀌지 않았습니다/)
})

test('업로드가 실패하면 새 만료일과 지금 서비스 중인 인증서의 만료일을 함께 알린다', async () => {
  const { s, calls, sent } = steps({ disk: at(9), issued: at(90), uploadFails: true })
  assert.equal(await renewIfNeeded(s), 'failed')
  assert.deepEqual(calls, ['issue', 'upload'])
  assert.match(sent[0]!, /2027-03-01/)
  assert.match(sent[0]!, /2026-12-10/)
  assert.match(sent[0]!, /node scripts\/dokploy-cert\.ts/)
})

test('올렸는데 도메인이 여전히 옛 인증서를 내주면 알린다. TLS 로 확인하지 못하면 성공으로 두되 그 사실을 적는다', async () => {
  const stale = steps({ disk: at(8), issued: at(90), served: at(8) })
  assert.equal(await renewIfNeeded(stale.s), 'failed')
  assert.match(stale.sent[0]!, /아직 2026-12-09 만료 인증서/)

  const unreachable = steps({ disk: at(8), issued: at(90), served: undefined })
  assert.equal(await renewIfNeeded(unreachable.s), 'renewed')
  assert.match(unreachable.sent[0]!, /TLS 로 확인하지는 못했습니다/)
})

test('force 는 아직 넉넉해도 갱신한다', async () => {
  const { s, calls } = steps({ disk: at(80), issued: at(90) })
  assert.equal(await renewIfNeeded(s, { force: true }), 'renewed')
  assert.deepEqual(calls, ['issue', 'upload'])
})
