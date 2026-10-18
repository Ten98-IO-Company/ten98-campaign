# Advertising connections and limits

Open **Ads manager** for Zernio campaigns, Google paid-search tools and the two native connections below. New campaigns start paused. Review targeting, account currency, budgets, creative approval and conversion setup before enabling delivery. Provider charges and account approvals apply.

The first installation owner is the **instance operator** and can save global credentials. Mapping an advertising account also requires owner/admin access to its workspace. Workspace editors can create and control campaigns; viewers can read. Zernio's Google account powers the main builder and Google Ads tools; the separate native Google credentials power Standard Shopping and Video reporting.

## Zernio and ChatGPT

An instance operator who administers the workspace maps one Zernio profile to each project in **Integrations**. Connect channels and load their accounts. The main ad builder creates the supported Meta, Google Search/Display/Performance Max/Demand Gen, TikTok, LinkedIn, Pinterest, X, Reddit and OpenAI formats. Zernio and each network determine availability.

For ChatGPT ads, use **Connect OpenAI Ads** in Integrations with your OpenAI Ads key. Zernio retains this provider credential; it is not saved as a local operation receipt. The app checks that the resulting account belongs to this project's profile. ChatGPT campaigns support daily or lifetime budgets, supported goals, automatic or fixed bidding, conversion-event selection and URL macros. The builder rejects invalid goal/budget/bidding combinations and offers provider validation without creating an ad. Lifetime budget changes preserve the existing allocation type; the supported conversion to daily is explicit. See [Zernio's OpenAI Ads contract](https://docs.zernio.com/platforms/openai-ads).

**Google Ads tools** manages positive and negative search keywords, campaign negatives, paid search terms, Keyword Planner ideas/history, supported geography/language/device targeting and bidding. Select the connected Google account, advertising customer and campaign before campaign changes. Keyword data can lag Google. Replacing campaign negatives replaces that entire set, including an explicitly confirmed empty set. Shared/portfolio configurations are guarded where this editor cannot safely change them.

## Native Google Shopping

In **Integrations → Google Ads native**, save and test:

- OAuth client ID and client secret.
- A refresh token obtained with Google's `https://www.googleapis.com/auth/adwords` scope.
- An approved Google Ads developer token, with access appropriate to your test or production account.
- Optionally, the ten-digit manager login customer ID when accessing a child account through a manager.

These credentials are separate from the Drive/Calendar service account. Complete Google's OAuth consent flow using your own registered application; the campaign app accepts the resulting refresh token and renews access tokens. The connection test only reads accessible customer metadata.

In Ads manager, an instance operator who also administers the workspace verifies and maps the ten-digit advertising customer ID. A customer can belong to only one project in this installation. Google must confirm access and the account currency; a manager account cannot be the advertising customer.

Expand **Create paused Standard Shopping campaign**. Supply the already linked Merchant Center account, an approved product feed label, priority, average daily budget, maximum CPC, target countries and political-ad declaration. Validation checks the setup without creating resources. Creation atomically adds a budget, paused campaign, paused ad group, paused product ad, all-products listing group and country targets. This includes every product in that feed; maintain product/feed eligibility in Merchant Center.

Native controls can enable the app-created campaign together with its tracked ad group and ad, pause its campaign and change an unshared daily budget with explicit confirmation and provider readback. Other Shopping campaigns retain their existing child switches. Existing Shopping and standard Video campaigns have date-scoped performance reporting; missing metrics remain unknown.

**Standard Video campaign creation is unavailable in Google's API.** Create those campaigns in Google Ads; use the Zernio builder for supported Demand Gen video creation. [Google's Video API limits](https://developers.google.com/google-ads/api/docs/video/overview).

## Native Microsoft Advertising

In **Integrations → Microsoft Advertising**, save your OAuth client ID, optional confidential-client secret, refresh token and developer token. Authorize your own registered application with `https://ads.microsoft.com/msads.manage` and `offline_access`; complete consent externally and paste the resulting refresh token. The connection test verifies the Advertising user without creating a campaign. [Microsoft authentication](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth?view=bingads-13).

In Ads manager, an instance operator who administers the workspace verifies the Microsoft customer and advertising account IDs. The account must belong to that customer and can be mapped to only one project. The editor creates an English Search campaign with responsive text ads, keywords, explicit location IDs, Maximize clicks bidding and a CPC cap. The campaign is paused; its child group, ad and keywords are ready for delivery once the campaign is explicitly activated. Review advanced targeting and creative settings in Microsoft Advertising.

Editors can create campaigns, confirm status/budget changes and request a campaign performance report. The latest requested report is restored after refresh; use **Check report status** while Microsoft returns Pending, then download its ZIP/CSV export when ready. Viewers can read campaigns and already requested reports. Export files come from Microsoft's scoped report download URL.

Eligible Search ads can reach Copilot inventory. Placement and approval are controlled by Microsoft, so creating or activating a campaign does not guarantee a Copilot impression. [Microsoft's AI marketer guide](https://www.about.ads.microsoft.com/content/dam/sites/msa-about/global/common/content-lib/pdf/microsoft-advertising-ai-marketers-guide.pdf).

## AI drafting and AI placements

In **AI agent**, ask the configured OpenRouter model for an ad creative draft. **Review in ad builder** transfers supported copy, keywords and public media references into the existing composer. Select the account and budget yourself before submitting. Suggestions never create or activate provider campaigns automatically; model inference is remote through OpenRouter.

Google Search, Shopping and Performance Max campaigns can be eligible for Google's AI search experiences under Google's market, targeting and auction rules. The app provides these paid campaign types; it does not promise an AI-only placement or separate AI Overviews reporting. [Google AI Overviews eligibility](https://support.google.com/google-ads/answer/16297775), [AI Mode advertising](https://business.google.com/us/accelerate/announcements/ads-in-ai-mode/).

No verified public campaign-management API was identified for additional AI ad platforms in this audit. They are not represented as working connections. Organic Search Console/SEO performance belongs in **ten98 Discover** and is outside this app.

## Credentials, recovery and acceptance

Native secrets are encrypted in the private database. Automatic refresh-token replacement is persisted without invalidating concurrent requests; administrative credential changes still invalidate in-flight verification. Back up the database and session secret together using the [deployment and operations instructions](../README.md#deployment-and-operations).

Every native mapping and action checks project access. Mutations use the shared operation ledger; uncertain writes remain blocked. An instance operator who also administers the workspace checks the provider dashboard, opens **Settings → Provider receipts & recovery**, and records **Applied** or **Not applied** with a note. Only Not applied allows a new manual attempt; the interface generates its new action key automatically. Review does not replay the request or update the campaign automatically. Manual campaign records cannot overwrite or delete provider-managed delivery evidence. Ordinary validation failures can be corrected and retried.

Automated and browser checks use isolated synthetic accounts and simulated provider responses. Live account acceptance still requires your credentials, developer-token approval, eligible products/creative, permissions and provider readbacks. The tests do not establish real placement or spending results.
