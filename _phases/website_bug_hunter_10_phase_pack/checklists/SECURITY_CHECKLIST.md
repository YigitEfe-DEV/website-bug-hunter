# Website Bug Hunter — Security Checklist

## Outbound URL safety
- [ ] Only HTTP/HTTPS schemes are allowed.
- [ ] URL parsing/normalization uses a trusted parser.
- [ ] Loopback, private, link-local, multicast, reserved, and metadata destinations are blocked.
- [ ] IPv4, IPv6, mapped IPv6, and parser edge cases are considered.
- [ ] DNS results are validated and actual connection destinations remain safe.
- [ ] DNS rebinding is addressed.
- [ ] Every redirect, discovered link, and asset is revalidated.
- [ ] Redirect loops and counts are bounded.
- [ ] Deployment-level outbound network restrictions are considered.

## Resource controls
- [ ] Request timeouts and overall scan deadlines exist.
- [ ] Response and decompressed sizes are bounded.
- [ ] Page count and crawl depth are bounded.
- [ ] Concurrency and total request count are bounded.
- [ ] Cancellation and failure paths release resources.
- [ ] Abuse/rate controls are appropriate to the deployment.

## Data safety
- [ ] Remote HTML is untrusted and not executed in a privileged context.
- [ ] User-controlled text is safely rendered.
- [ ] Public errors do not reveal stack traces or internal network details.
- [ ] Reports and exports omit secrets, cookies, authorization headers, and environment variables.
- [ ] Logs redact sensitive values.

## Verification (complete in Phase 10)
- [ ] SSRF tests cover initial URLs, redirects, discovered links, and assets.
- [ ] Resource limits and timeout behavior are tested.
- [ ] Partial failures and cleanup are tested.
- [ ] Dependency audit is run where supported.
- [ ] Residual risks and mitigations are documented.
