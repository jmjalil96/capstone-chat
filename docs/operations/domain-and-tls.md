# Domain and TLS

The application origin is exactly `https://chat.capstone.com.ec`; transactional mail uses the
separate `mail.capstone.com.ec` sending domain. DNS or provider changes require the user's immediate
authorization. Record hostnames, record types, status, and UTC time only—never account identifiers,
verification tokens, credentials, or complete provider responses.

## Application domain

1. In Render, add `chat.capstone.com.ec` to the one production Web Service while its generated
   subdomain is still enabled.
2. At the authoritative DNS provider, remove conflicting records and add the exact target Render
   displays. Do not invent an IP address or copy a target from another Render service.
3. Confirm any CAA policy permits the certificate authority Render currently documents before
   waiting for issuance. Do not broaden unrelated `capstone.com.ec` policy without approval.
4. Wait for Render to report DNS verified and the managed certificate valid. Verify the certificate
   chain, hostname, validity window, and automatic-renewal status from an external client.
5. Verify HTTP redirects to the exact HTTPS origin. At the final origin, check readiness, the SPA
   shell, one fingerprinted asset, an unknown `/api/*` 404, authentication redirects/cookies, and a
   timed NDJSON stream. Confirm production HSTS is exactly `max-age=31536000`, without
   `includeSubDomains` or `preload`.
6. Prove that spoofed `X-Forwarded-For` and `x-capstone-client-ip` values do not replace Render's
   single trusted edge address. Stop if Render no longer overwrites the documented
   `CF-Connecting-IP` boundary; do not weaken proxy trust.
7. Only after these checks pass, apply the Blueprint's final `renderSubdomainPolicy: disabled` and
   repeat the domain, authentication, asset, and streaming checks. Confirm no callback, email, CSP,
   or asset URL refers to the generated Render hostname.

## Email domain

1. In Resend, add `mail.capstone.com.ec` and copy the exact provider-issued SPF and DKIM records to
   authoritative DNS. Do not reuse the application-domain record or enable mail receiving.
2. Wait for every required record to verify. Confirm the exact sender is
   `Capstone Chat <no-reply@mail.capstone.com.ec>`, the key is send-only and domain-restricted, and
   open/click tracking is disabled.
3. Before identity bootstrap, send controlled invitation, verification, and password-reset
   messages. Verify final-origin links, Spanish HTML, plain-text fallback, and desktop/mobile
   rendering without retaining action URLs in evidence.

## Rollback

If custom-domain verification fails before cutover, keep the generated Render hostname enabled,
leave production unannounced, and restore the previous DNS records from the approved change record.
If a certificate, redirect, authentication, or streaming failure appears after cutover, re-enable
the generated hostname for operator diagnosis only, roll back the application when compatible, and
restore the last known-good DNS target if the fault is DNS-specific. Never change `PUBLIC_ORIGIN` to
the generated hostname or send identity email from an unverified domain. Close the incident only
after the custom origin passes the full checks again and DNS caches have converged.
