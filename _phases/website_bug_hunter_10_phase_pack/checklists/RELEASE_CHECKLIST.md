# Website Bug Hunter — Release Checklist

## Product
- [ ] Core scanning works against controlled fixtures.
- [ ] Reports include evidence and uncertainty.
- [ ] Limitations are documented.
- [ ] Loading, empty, success, partial, and failure states are handled.
- [ ] Keyboard and responsive usability have been reviewed.

## Engineering (verify in Phase 10)
- [ ] Tests pass.
- [ ] Lint passes.
- [ ] Type checks pass where applicable.
- [ ] Production build passes.
- [ ] Smoke test passes.
- [ ] Dependency audit reviewed where available.
- [ ] No release blocker is hidden.

## Security
- [ ] SSRF protections cover all outbound requests.
- [ ] Redirects and DNS resolution are handled safely.
- [ ] Resource limits are enforced.
- [ ] Logs and exports do not leak sensitive data.
- [ ] Secrets are not committed.
- [ ] Residual risks are documented.

## Documentation
- [ ] README setup commands are verified.
- [ ] Environment variable names are accurate.
- [ ] `.env.example` contains placeholders only.
- [ ] CONTRIBUTING and SECURITY docs match the repository.
- [ ] License status is clear.
- [ ] Screenshots and badges are genuine.

## Release
- [ ] Deployment requirements and resource limits are documented.
- [ ] No deployment, paid resource, or remote push occurred without authorization.
- [ ] Release notes match actual changes.
- [ ] Remaining risks are disclosed.
