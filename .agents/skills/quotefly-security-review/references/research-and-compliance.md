# Research and compliance boundaries

## Research rules

For anything described as latest, current, required, vulnerable, compliant, or deprecated:

1. Verify the current date, deployed/runtime version, package version, provider mode, and relevant jurisdiction.
2. Prefer primary sources in this order:
   - vendor security advisories and official provider documentation;
   - CVE records, NVD, OSV, and official package/repository advisories;
   - OWASP, NIST, and CISA standards or guidance;
   - regulator guidance and statutory/regulatory text.
3. Cite the exact source and its date/version. Explain any inference.
4. Avoid generic security blogs, copied compliance checklists, and search snippets as evidence.
5. Recheck sources at review time; do not assume the baseline links below are still current.

## Current baseline sources

- OWASP ASVS project and latest stable release: https://owasp.org/www-project-application-security-verification-standard/
- OWASP Top 10:2025: https://owasp.org/Top10/2025/0x00_2025-Introduction/
- NIST Secure Software Development Framework (SP 800-218): https://csrc.nist.gov/pubs/sp/800/218/final
- CISA Secure by Design: https://www.cisa.gov/securebydesign
- FTC data-security guidance: https://www.ftc.gov/business-guidance/privacy-security/data-security
- California Privacy Protection Agency laws and regulations: https://cppa.ca.gov/regulations/
- EDPB consent guidance: https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en
- ICO storage/access and cookie guidance: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/
- PCI Security Standards Council: https://www.pcisecuritystandards.org/
- Stripe webhook security: https://docs.stripe.com/webhooks
- Twilio webhook security: https://www.twilio.com/docs/usage/webhooks/webhooks-security
- QuickBooks Online developer documentation: https://developer.intuit.com/app/developer/qbo/docs/get-started
- OpenAI API data controls: https://platform.openai.com/docs/guides/your-data

Use ASVS as a verification framework and OWASP Top 10 as risk awareness; neither is a certification by itself. Use NIST SSDF to assess development-process controls and CISA guidance for secure-by-design/default decisions.

## Compliance boundaries

- First determine customer locations, business locations, data subjects, data categories, annual scale/revenue thresholds, provider contracts, and whether regulated data is intentionally accepted.
- Do not assume CCPA/CPRA, GDPR/UK GDPR/ePrivacy, PCI DSS, HIPAA, GLBA, CAN-SPAM, TCPA, state breach laws, or sector rules apply—or do not apply—without checking scope.
- Stripe-hosted payment collection can reduce card-data scope but does not automatically remove all PCI responsibilities. Confirm the live integration and current PCI SSC eligibility criteria.
- A cookie banner is not proof of compliance. Inventory actual cookies, local/session storage, pixels, analytics, and third-party scripts; confirm non-essential technologies stay off before consent where required.
- Security controls do not replace operational evidence. Review vendor agreements, subprocessors, retention/deletion execution, access reviews, backup restores, incident response, breach notification, and customer request procedures.
- Label results precisely: “implemented control,” “test passed,” “aligned with,” “not evaluated,” or “requires counsel.” Never claim certification or guaranteed legal compliance.
