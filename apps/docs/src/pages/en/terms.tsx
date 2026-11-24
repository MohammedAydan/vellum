import { AlphaNotice, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc eyebrow="Legal" title="Terms of Service" description="Acceptable use, technical limits, intellectual property, and the Alpha notice and disclaimer.">
      <AlphaNotice />
      <P>Last updated: November 24, 2026. By using VELLUM you agree to these terms. If you do not agree, do not use the service.</P>

      <Section id="alpha" title="Alpha status and no guarantees">
        <UL items={[
          <><strong>Active development:</strong> VELLUM is currently under continuous development (Alpha/Beta). It is not a final, stable product.</>,
          <><strong>No uptime or stability guarantee:</strong> there is no service level agreement (SLA). We do not guarantee that the service will keep running, stay stable, or keep test data safe. APIs and services may change in breaking ways, be modified, or be shut down completely and permanently at any time without prior notice.</>,
          <><strong>Full disclaimer:</strong> the service is provided &quot;AS IS&quot; and &quot;AS AVAILABLE&quot;, without any express or implied warranties, including merchantability, fitness for a particular purpose and non-infringement. You alone bear the full personal and legal responsibility for deciding to use it in any project. To the fullest extent permitted by law, the developers and owners of the project are not liable for any direct or indirect damages, including data loss, lost profits or business interruption, that result from use of the service or from its interruption.</>,
        ]} />
      </Section>

      <Section id="use" title="Acceptable use">
        <UL items={[
          "Do not use the service for anything unlawful, or to store content you have no right to store.",
          "Do not attempt to break, probe, overload or bypass the security, isolation or quotas of the service or of other users.",
          "Do not send malware, spam or abusive traffic, and do not resell access without permission.",
          "Keep your API keys and credentials secret. You are responsible for activity that uses them.",
        ]} />
      </Section>

      <Section id="limits" title="Technical limits">
        <P>The service enforces request, document, query and rate limits described in <PageLink slug="errors-and-limits">Quotas &amp; limits</PageLink>. Limits can change during Alpha. We may throttle or suspend usage that threatens the stability or security of the service.</P>
      </Section>

      <Section id="ip" title="Intellectual property">
        <P>You keep all rights to the data and content you store. You grant us only the permission needed to host, process and back up it in order to run the service for you. VELLUM, its software, name and documentation remain the property of their owners and are provided under the license that ships with each package.</P>
      </Section>

      <Section id="changes" title="Changes and termination">
        <P>We may update these terms, and we may suspend or end the service or your access at any time. Continued use after a change means you accept it. See also the <PageLink slug="privacy">Privacy Policy</PageLink>.</P>
      </Section>
    </Doc>
  );
}
