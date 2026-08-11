# Domain and TLS

The application origin is exactly `https://chat.capstone.com.ec`; transactional mail uses the
separate `mail.capstone.com.ec` sending domain. DNS, certificate, firewall, or provider changes
require immediate action-specific authorization. Record hostnames, record types, status, and UTC
time only—never account identifiers, challenges, credentials, complete provider responses, or
identity-action URLs.

## Application domain

1. Confirm the assigned DigitalOcean reserved IPv4 is attached to the approved RIC1 Droplet and is
   also the persistent outbound source observed by PlanetScale after a reboot. Do not publish the
   Droplet's ephemeral address.
2. Confirm DigitalOcean Cloud Firewall and UFW expose only TCP 80/443 publicly. SSH remains limited
   to the currently approved operator `/32`; application ports 3001/3002, Caddy's admin socket,
   Docker, Fluent Bit, metrics, and PostgreSQL are not public.
3. At the authoritative DNS provider, remove conflicting `A`/`AAAA` records and create one direct
   DNS-only `A` record for `chat.capstone.com.ec` to the reserved IPv4. If Cloudflare manages DNS,
   keep proxying disabled. Do not add a CDN, tunnel, load balancer, or public IPv6 record.
4. Confirm any CAA policy permits Caddy's current ACME certificate authority without broadening
   policy for unrelated `capstone.com.ec` hosts. Mount Caddy's certificate/account state only from
   its private directory on the encrypted Volume.
5. Validate and load the committed Caddy configuration through its permissioned Unix admin socket.
   Confirm there is no TCP admin listener, persisted API configuration, access log, negative
   `flush_interval`, response buffering, compression, or synthetic `Content-Length` for NDJSON.
6. Wait for certificate issuance and verify the public chain, hostname, validity window, and renewal
   behavior externally. Confirm HTTP redirects to the exact HTTPS origin.
7. At the final origin, verify readiness, the SPA shell, one fingerprinted asset, unknown `/api/*`
   handling, authentication redirects/cookies, CSP, HSTS exactly `max-age=31536000` without
   `includeSubDomains`/preload, and `no-store, no-transform` NDJSON.
8. Prove public `Forwarded`, `X-Forwarded-*`, `CF-Connecting-IP`, and
   `X-Capstone-Client-IP` values cannot choose the application client address. Prove a real client
   disconnect passes through Caddy, aborts the backend/gateway, and preserves durable partial output.
9. Run a long timed stream through a Caddy reload and active-slot switch. Existing connections must
   not reset, buffer, reorder, or lose deltas; new traffic must reach only the durable active slot.

## Email domain

1. In Resend, add `mail.capstone.com.ec` and copy the exact provider-issued SPF and DKIM records to
   authoritative DNS. Do not reuse the application record or enable inbound mail.
2. Wait for all required records to verify. Confirm the exact sender is
   `Capstone Chat <no-reply@mail.capstone.com.ec>`, the key is send-only and domain-restricted, and
   open/click tracking is disabled.
3. Before identity bootstrap, send controlled invitation, verification, and password-reset messages.
   Verify final-origin links, Spanish HTML, plain-text fallback, expiry, and desktop/mobile rendering
   without retaining recipients or action URLs in evidence.

## Rollback

Before public cutover, leave production unannounced if DNS or ACME verification fails and restore the
last approved DNS state. After cutover, keep the reserved IP attached while diagnosing Caddy or the
application. Roll back only through the compatible active-release procedure; restore DNS only when
the fault is specific to the address or authoritative record. Never change `PUBLIC_ORIGIN`, enable a
proxy/CDN, publish an application port, or use an unverified hostname as a shortcut. Close the
incident only after the custom origin passes the complete checks again and DNS caches have converged.
