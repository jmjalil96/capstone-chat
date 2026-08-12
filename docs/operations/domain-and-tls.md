# Domain, managed edge, and TLS

The application origin remains exactly `https://chat.capstone.com.ec`; transactional mail uses
`mail.capstone.com.ec`. DigitalOcean App Platform and its Cloudflare-backed edge terminate public
TLS and can process plaintext prompts, responses, cookies, and identity links. Domain attachment is
permitted under the owner's August 12, 2026 acceptance of the current DPA, subprocessors,
processing/support regions, request/edge logging and retention, employee access, deletion, breach,
and incident terms. The owner explicitly accepted that public documentation does not fully quantify
every internal edge-log retention and employee-access detail. Recheck material contract changes
before production launch; never describe this boundary as end-to-end encryption to the container.

DNS, domain, certificate, edge, or provider changes require immediate action-specific
authorization. Record hostnames, record types, status, and UTC time only—never account IDs,
challenges, credentials, full provider responses, employee content, or identity-action URLs.

## Application domain

1. Query the authoritative zone and parent delegation immediately before attachment. App Platform
   does not support attaching a DNSSEC-enabled domain. If `DS`/`DNSKEY` shows DNSSEC is enabled,
   stop for a separate provider/security decision; never disable it silently.
2. Inspect CAA. If present, it must authorize both `letsencrypt.org` and `pki.goog`; otherwise stop
   until the owner approves the exact DNS correction. A prior planning query is not launch evidence.
3. Fetch the current App spec and provider-generated `.ondigitalocean.app` target. Confirm the App
   ID, managed `ric` region, Dedicated Egress, health-only maintenance or ready service state, and
   absence of any conflicting domain. Never copy a historical target.
4. With the release pointer frozen to the accepted source commit, attach exactly
   `chat.capstone.com.ec` as `PRIMARY` with `minimum_tls_version: "1.2"` and no App-managed DNS
   `zone`. Preserve the provider `DEFAULT` starter domain returned by the live spec.
5. At Hostinger authoritative DNS, remove conflicting `A`/`AAAA` records and publish a DNS-only
   CNAME from `chat` to the current provider target. Do not add another CDN/proxy, wildcard,
   secondary authenticated origin, direct service address, or App-managed zone.
6. Preserve the authority-specific ingress rule that redirects exactly the fetched starter domain
   over HTTPS with status 308 to `chat.capstone.com.ec`, without a replacement URI so path and query
   survive. The starter domain must not establish an independent authenticated origin.
7. With the custom domain attached, introduce the custom-domain-only edge controls together:
   disable App Platform edge caching and email obfuscation, and leave enhanced threat control
   disabled for this authenticated streaming service. These fields are unavailable and remain
   absent during bootstrap/egress while only the starter domain exists. A future threat-control
   change requires measured auth, cancellation, and streaming evidence.
8. Wait for managed certificate issuance. Verify public chain, hostname, validity, renewal state,
   minimum TLS, HTTP-to-primary HTTPS redirect, and the provider domain's redirect externally.
9. At the final origin verify the SPA shell, fingerprinted asset, unknown API handling,
   authentication redirects/cookies, CSP, HSTS `max-age=31536000` without subdomain/preload scope,
   API/HTML cache policy, and `no-store, no-transform` NDJSON.
10. Verify public non-health requests carry one valid provider `do-connecting-ip` address and that
    employee-visible rate limiting/audit uses the real client. Test omitted, forged, duplicated,
    comma-joined, malformed, IPv4, and IPv6 cases. Health probes may omit the header; every other
    route fails closed. `Forwarded`, every `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, and the
    retired `X-Capstone-Client-IP` must not become authority.
11. Exercise incremental NDJSON, a quiet stream with 15-second heartbeats, a stream through the
    five-minute application ceiling, 35-second browser silence recovery after truncation, Stop,
    disconnect, slow-reader backpressure, and durable partial recovery through the real edge.
12. Exercise a deployment during a healthy long stream and a stalled stream. Verify readiness
    routing, 110-second edge drain, `SIGTERM`, bounded 300-second grace, no duplicate work, and
    canonical recovery after forced termination.

If the edge preserves an attacker-selected client header, buffers/truncates the stream, transforms
authenticated responses, or fails the privacy contract, reject the candidate. Do not fall back to
`X-Forwarded-For`, another CDN, or a direct container origin.

## Planned replacement and deletion

Preserve the current App ID when possible. Before a controlled replacement or deletion, enable
maintenance, detach `chat.capstone.com.ec`, and verify DigitalOcean has released the binding. Attach
it to the already verified replacement and complete smoke before deleting the old App. Deleting an
App while its domain remains attached can retain the binding for up to 24 hours; this exceeds the
four-hour controlled-recovery RTO. The owner approved a best-effort, maximum 24-hour exception for
that accidental-deletion failure mode on August 12, 2026. Controlled replacement and every other
recovery retain the four-hour target.

Delete authority is short-lived, separate from deploy/console/provisioning authority, and granted
only after domain release. A failed domain operation restores the last approved App configuration
and DNS state; it never changes `PUBLIC_ORIGIN` or introduces an alternate authenticated origin.
Because a configuration change can rebuild source, verify the resulting component source commit
before proceeding.

## Email domain

1. In Resend, verify `mail.capstone.com.ec` and publish only the exact provider-issued SPF/DKIM
   records. Do not reuse the application CNAME or enable inbound mail.
2. Confirm `Capstone Chat <no-reply@mail.capstone.com.ec>`, a send-only domain-restricted key, and
   disabled open/click tracking.
3. Send controlled invitation, verification, and reset messages only after the final service is
   ready. Verify production-origin fragment links, Spanish HTML, plain text, expiry, and current
   desktop/mobile rendering without retaining recipients or action URLs in evidence.
