/**
 * Renewing the admin page's certificate before it lapses.
 *
 * The certificate is issued on the broker machine (scripts/issue-cert, DNS-01 through acme-dns) and served by
 * Dokploy's Traefik, which cannot renew it itself because the domain only resolves to a Tailscale
 * address. So nothing renews it unless this runs: once a day, and only when it is close to expiring.
 *
 * The steps are passed in, so the decision (when to renew, what to do when a step fails, what to tell
 * the person) can be tested without a certificate authority, Dokploy or Slack.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Let's Encrypt certificates last 90 days; renewing with a month left leaves time to fix a failure. */
export const RENEW_WITHIN_DAYS = 30

export interface RenewSteps {
  /** When the certificate on disk expires. Undefined when there is none or it cannot be read. */
  expiry(): Promise<Date | undefined>
  /** Get a new certificate and put it where the upload step reads it. */
  issue(): Promise<void>
  /** Hand the certificate to Dokploy. */
  upload(): Promise<void>
  /** When the certificate the domain actually serves expires, read over TLS. Undefined when it could not be reached. */
  served(): Promise<Date | undefined>
  /** Tell the person: a channel message, as this is unattended. */
  notify(text: string): Promise<void>
  log(message: string): void
  now?: () => Date
}

export type RenewOutcome = 'fresh' | 'renewed' | 'failed'

const fmt = (d: Date) => d.toISOString().slice(0, 10)
const days = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS)
const say = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n').filter(Boolean).slice(-4).join(' · ').slice(0, 400)

/** Renew when the certificate has less than `withinDays` days left, or is missing, or `force` is set. */
export async function renewIfNeeded(steps: RenewSteps, opts: { withinDays?: number; force?: boolean } = {}): Promise<RenewOutcome> {
  const now = (steps.now ?? (() => new Date()))()
  const before = await steps.expiry()
  const left = before ? days(now, before) : undefined
  if (!opts.force && left !== undefined && left > (opts.withinDays ?? RENEW_WITHIN_DAYS)) {
    steps.log(`certificate is good for ${left} more days (until ${fmt(before!)}); nothing to do`)
    return 'fresh'
  }
  steps.log(left === undefined ? 'no certificate on disk; issuing one' : `certificate expires in ${left} days (${fmt(before!)}); renewing`)

  try {
    await steps.issue()
  } catch (err) {
    steps.log(`issuing failed: ${say(err)}`)
    await steps.notify(`⚠️ 어드민 페이지 인증서 갱신에 실패했습니다 (발급 단계). ${left === undefined ? '' : `${left}일 뒤 만료됩니다. `}${say(err)}\n\`sh scripts/issue-cert\` 를 직접 실행해 원인을 확인하세요.`).catch(() => {})
    return 'failed'
  }
  const after = await steps.expiry()
  if (!after || (before && after.getTime() <= before.getTime())) {
    steps.log('issuing finished but the certificate on disk did not get newer')
    await steps.notify(`⚠️ 인증서 발급은 끝났는데 파일이 새 것으로 바뀌지 않았습니다. \`sh scripts/issue-cert\` 를 직접 실행해 보세요.`).catch(() => {})
    return 'failed'
  }

  try {
    await steps.upload()
  } catch (err) {
    steps.log(`uploading failed: ${say(err)}`)
    await steps.notify(`⚠️ 새 인증서(${fmt(after)} 까지)를 발급했지만 Dokploy 에 올리지 못했습니다. ${say(err)}\n\`node scripts/dokploy-cert.ts\` 를 직접 실행하세요. 지금 서비스 중인 인증서는 ${before ? fmt(before) : '?'} 에 만료됩니다.`).catch(() => {})
    return 'failed'
  }

  // Traefik picks the file up within seconds; look at what is really being served.
  const served = await steps.served().catch(() => undefined)
  if (served && Math.abs(served.getTime() - after.getTime()) > DAY_MS) {
    steps.log(`the domain still serves a certificate that expires ${fmt(served)}, not ${fmt(after)}`)
    await steps.notify(`⚠️ 새 인증서(${fmt(after)} 까지)를 Dokploy 에 올렸지만 도메인은 아직 ${fmt(served)} 만료 인증서를 내주고 있습니다. 잠시 뒤에도 그러면 Dokploy 를 확인하세요.`).catch(() => {})
    return 'failed'
  }
  steps.log(`renewed; expires ${fmt(after)}${served ? ' (confirmed over TLS)' : ' (could not confirm over TLS)'}`)
  await steps.notify(`🔐 어드민 페이지 인증서를 갱신했습니다. 새 만료일: ${fmt(after)}${served ? '' : ' (TLS 로 확인하지는 못했습니다)'}`).catch(() => {})
  return 'renewed'
}
