# 0006. Cloudflare Origin CA certificate behind the Cloudflare proxy

## Context

`chambalink.online` needs HTTPS. DNS for the domain is hosted on Cloudflare, and both the apex and `www` records are proxied, so every client connection terminates at Cloudflare and Cloudflare opens a separate connection to the origin. The origin needs a certificate that Cloudflare can validate. The alternative was a publicly trusted certificate from Let's Encrypt, issued and renewed with certbot on the VM.

## Decision

Terminate TLS in nginx with a Cloudflare Origin CA certificate, serve clients through the Cloudflare proxy, and set Cloudflare's SSL/TLS mode to Full (strict). The RSA 2048 private key is generated on the VM, and only the CSR is submitted to Cloudflare.

## Consequences

- No renewal automation exists. The certificate expires on Oct 18 2041.
- Cloudflare sends no expiry notifications for Origin CA certificates.
- The certificate is trusted only by Cloudflare. A client that reaches the origin directly gets an untrusted-certificate error unless it trusts Cloudflare Origin CA, and browsers trust the site only while the records are proxied.
- Full (strict) makes Cloudflare reject the origin if it presents a certificate that does not validate against Cloudflare Origin CA.
- The private key has not left the VM.
- The certificate is bound to the hostnames, not to the VM, so the same certificate and key work on any origin behind the Cloudflare proxy.
