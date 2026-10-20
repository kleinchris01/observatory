# GitHub Actions — Secrets & Variables Reference

## Repository Secrets
(Settings → Secrets and variables → Actions → Repository secrets)

### Required for Forge deployment
| Secret | Description |
|--------|-------------|
| `FORGE_EMAIL` | Atlassian account email used to authenticate `forge` CLI |
| `FORGE_API_TOKEN` | Atlassian API token — generate at id.atlassian.com/manage-profile/security/api-tokens |

### Optional
| Secret | Description |
|--------|-------------|
| `CODECOV_TOKEN` | Token from codecov.io for coverage reporting |

---

## Deploy notifications

None today. The Slack failure notification was removed on 19 Oct 2026: it was never configured,
and its design read the webhook from a repository **variable**, which GitHub does not mask in logs.

If it comes back, store the webhook as a repository **secret** (`SLACK_WEBHOOK_URL`), read it as
`${{ secrets.SLACK_WEBHOOK_URL }}`, and add it to the CI secrets table in `SECURITY_CHECKLIST.md`.

---

## Forge Environments

The deploy workflow targets one of three Forge environments:
- `development` — local `forge tunnel` development
- `staging` — pre-production Atlassian cloud environment
- `production` — live Atlassian cloud environment

Set `FORGE_EMAIL` and `FORGE_API_TOKEN` for the account that has deploy access to all environments.

---

## Setting Up Forge Auth for CI

1. Create an Atlassian API token at: https://id.atlassian.com/manage-profile/security/api-tokens
2. Add to GitHub: Settings → Secrets and variables → Actions → New repository secret
   - `FORGE_EMAIL`: your Atlassian email
   - `FORGE_API_TOKEN`: the token you created
3. Verify: `forge whoami` locally should show your account
