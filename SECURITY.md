# Security Policy

## Supported Versions

We support the latest published MeMesh release. Older releases should be assumed unsupported unless a maintainer says otherwise.

| Version | Supported |
|---------|-----------|
| Latest published release | Yes |
| Older releases | No |

## What automatic updates trust

Automatic updates install a release only after checking that npm's provenance names this repository's release workflow at that version's tag, that the signing certificate says the same, that the attested commit is part of the `main` branch (asked of GitHub directly), and that the package pins every dependency. That is a check of where a release came from, not of what it contains. Whoever can push to `main` and cause the release workflow to run on a tag can ship a release that passes every one of these checks, and the updater of every install that follows `latest` will install it. The protection against that is who may push to `main` and create release tags in this repository, not something the updater can verify. Turn automatic updates off (`memesh config set autoUpdate off`) if you want to read a release before it runs.

## Reporting a Vulnerability

Do not post vulnerability details in public GitHub issues.

GitHub private vulnerability reporting is not currently enabled for this
repository. Use an existing private maintainer contact, or
[open an issue](https://github.com/PCIRCLE-AI/memesh/issues/new) asking a
maintainer how to report privately. Include no vulnerability details in that
public request; wait for a private contact before sharing them.

## What to Include

- A clear description of the issue
- Steps to reproduce
- Impact assessment
- A proposed fix, if you have one
- Contact details for follow-up

## Response Targets

- Acknowledgment: within 48 hours
- Initial assessment: within 5 business days
- Resolution targets:
  - Critical: 24-48 hours
  - High: 3-7 days
  - Medium: 7-14 days
  - Low: next scheduled release

These are targets, not guarantees, but we use them to drive triage and communication.

## Disclosure

Please give us reasonable time to investigate and ship a fix before public disclosure. We will coordinate disclosure timing with reporters when possible and credit valid reports unless you prefer to stay anonymous.
