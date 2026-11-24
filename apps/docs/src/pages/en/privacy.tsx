import { AlphaNotice, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc eyebrow="Legal" title="Privacy Policy" description="What data VELLUM collects, how it is stored and protected, and that it is never sold or shared.">
      <AlphaNotice />
      <P>Last updated: November 24, 2026. VELLUM is an Alpha service, so this policy may change as the product changes.</P>

      <Section id="collected" title="Data we collect">
        <UL items={[
          <><strong>Account data:</strong> your email address, name and a password hash, plus the organizations and projects you create.</>,
          <><strong>Your application data:</strong> the documents, indexes, rules and keys you store in your projects. You own it and we treat it as yours.</>,
          <><strong>End-user data of your apps:</strong> sign-in identifiers and sessions of the people who use your applications, stored in your project.</>,
          <><strong>Operational data:</strong> request logs and usage counters (such as request counts, IP address and timestamps) used to run, secure and meter the service.</>,
        ]} />
      </Section>

      <Section id="protection" title="Encryption and storage">
        <UL items={[
          "Traffic to the API is served over HTTPS (TLS).",
          "Passwords are never stored in plain text. They are stored as salted scrypt hashes.",
          "Authentication secrets, such as multi-factor seeds, are encrypted at rest with AES-256-GCM.",
          "Your documents are stored in PostgreSQL, isolated per project with row-level security. Encryption at rest of the database volume depends on the database host.",
          "Because the service is in Alpha, do not store data you cannot afford to lose or that is regulated or highly sensitive.",
        ]} />
      </Section>

      <Section id="sharing" title="No sale or sharing">
        <P>We do not sell your data and we do not share it with third parties for advertising or marketing. We use infrastructure providers (for hosting and databases) only to run the service, and we may disclose data if the law requires it.</P>
      </Section>

      <Section id="retention" title="Retention and your choices">
        <P>We keep your data while your account is active. You can delete documents, projects and your account, and deletion removes the data from the live service. Backups and logs may remain for a limited time. Because this is an Alpha service, data may also be lost or reset without notice. See the <PageLink slug="terms">Terms of Service</PageLink>.</P>
      </Section>

      <Section id="changes" title="Changes to this policy">
        <P>We will update the date above when this policy changes. Continued use after a change means you accept the updated policy.</P>
      </Section>
    </Doc>
  );
}
