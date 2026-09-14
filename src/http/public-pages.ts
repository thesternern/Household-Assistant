import type { Context } from 'hono'

/**
 * The public pages two reviewers require: a home page and a privacy policy for
 * Google's OAuth consent screen, and a privacy policy plus terms for Twilio's
 * A2P 10DLC campaign registration.
 *
 * All three are deliberately constant. They import neither the config nor the
 * database, because both reviewers fetch them at moments we do not control —
 * during a deploy, or while Postgres is cold — and a page that 500s there
 * blocks registration with no signal visible from either console.
 *
 * The texting sections carry language the carriers check for by name: that
 * mobile numbers are never shared, how often messages arrive, and that message
 * and data rates may apply. Reword them freely; do not remove them.
 *
 * Nothing here is a brochure. These pages exist to satisfy the two reviews and
 * to tell a text recipient what they have been signed up for, and they say
 * nothing about how the assistant is reached or what it runs on.
 */

const LAST_UPDATED = '3 September 2026'

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto; padding: 3rem 1.25rem; max-width: 42rem;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .sub { opacity: .7; margin: 0 0 2rem; font-size: .9rem; }
  li { margin: .35rem 0; }
  code { font-size: .9em; }
`

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`
}

/* ─────────────────────────────────── home ────────────────────────────────── */

const HOME = page(
  'Household assistant',
  `<h1>Household assistant</h1>
<p class="sub">A private assistant for one family.</p>
<p>
  This is a personal, invitation-only assistant that helps a single household
  manage its mail, calendar, meals, and errands. It is not a product, it has no
  sign-up, and it serves no users beyond the two people who run it.
</p>
<p><a href="/privacy">Privacy policy</a> &middot; <a href="/terms">Terms</a></p>`,
)

/** `GET /` — the application home page named on the OAuth consent screen. */
export function handleHome(c: Context): Response {
  return c.html(HOME)
}

/* ────────────────────────────────── privacy ──────────────────────────────── */

const PRIVACY = page(
  'Privacy policy',
  `<h1>Privacy policy</h1>
<p class="sub">Last updated ${LAST_UPDATED}</p>

<p>
  This assistant is operated privately by one household for its own use. It has
  no public sign-up and no users other than the two household members who
  authorise it. This policy describes what it accesses on their behalf.
</p>

<h2>What it accesses</h2>
<p>With explicit consent, and only for the accounts a household member links:</p>
<ul>
  <li><strong>Read your mail.</strong> To triage the inbox, watch for messages
      the household is expecting, and write the morning summary.</li>
  <li><strong>Create drafts.</strong> To compose replies for a person to review
      before anything is sent.</li>
  <li><strong>Send mail.</strong> To deliver replies and errands a household
      member has approved.</li>
  <li><strong>Read and write your calendar.</strong> To show what is coming up
      and to add events the household asks for.</li>
  <li><strong>Your account's email address.</strong> Only so the assistant can
      report which account it just linked.</li>
</ul>
<p>
  It never labels, archives, or deletes mail: the permission that would allow
  that is deliberately not requested.
</p>

<h2>How it is stored</h2>
<ul>
  <li>Access credentials are encrypted before they are written to the database,
      which is private to this household.</li>
  <li>Activity records are kept for a limited retention window — 90 days by
      default — and then deleted.</li>
  <li>Message and calendar content is read as needed to answer a request. It is
      not copied into any external store.</li>
</ul>

<h2>Processing</h2>
<p>
  To interpret requests and draft replies, relevant message text is sent to
  Anthropic's API, which returns the assistant's response. No other third party
  receives this data.
</p>

<h2>What it never does</h2>
<p>
  Your data is <strong>never sold, never shared</strong> with anyone outside the
  household, never used for advertising, and never used to build a profile of
  you or anyone who writes to you.
</p>

<h2>Text messages</h2>
<p>
  The household's assistant sends text messages from its own phone number to
  people a household member already deals with — a sitter, a clinic, a
  tradesperson — who gave that household member their mobile number and agreed
  to be texted about the arrangement being made. Numbers are entered by hand,
  one at a time. Nothing is imported, purchased, or taken from a list.
</p>
<ul>
  <li><strong>Mobile numbers are never shared.</strong> No mobile information is
      sold, rented, or shared with any third party or affiliate for marketing or
      promotional purposes, and none is shared with anyone outside the household
      for any other purpose. Numbers reach the telecommunications provider that
      carries the message, and go no further.</li>
  <li><strong>Message frequency.</strong> A few messages a week at most, and only
      while an errand is being settled. There are no recurring, scheduled, or
      promotional messages, and no messages are sent to anyone who has not been
      saved to the address book by hand.</li>
  <li><strong>Message and data rates may apply.</strong> Your mobile carrier may
      charge for messages you send or receive.</li>
  <li><strong>Stopping.</strong> Reply <code>STOP</code> to end messaging at any
      time. It takes effect immediately and permanently: the number is marked
      unreachable and cannot be texted again, even by mistake. Only you can undo
      it, by replying <code>START</code>. Reply <code>HELP</code> for help.</li>
  <li><strong>What is kept.</strong> The text of the exchange is stored in the
      household's private database so the household has a record of what was
      agreed, under the same retention window as everything else above.</li>
</ul>

<h2>Revoking access</h2>
<p>
  You can withdraw this assistant's access to your Google account at any time at
  <code>myaccount.google.com/permissions</code>. Access stops immediately, and
  the stored credentials become unusable.
</p>

<h2>Contact</h2>
<p>
  Questions go to the support address shown on the consent screen you used to
  grant access.
</p>`,
)

/** `GET /privacy` — the privacy policy URL named on the OAuth consent screen. */
export function handlePrivacy(c: Context): Response {
  return c.html(PRIVACY)
}

/* ─────────────────────────────────── terms ───────────────────────────────── */

const TERMS = page(
  'Terms',
  `<h1>Terms</h1>
<p class="sub">Last updated ${LAST_UPDATED}</p>

<p>
  This assistant is operated privately by one household for its own use. It is
  not a product and not a service offered to anyone. There is no sign-up, nothing is sold, and there are no customers.
  These terms cover the one thing an outside person encounters: a text message.
</p>

<h2>Who is writing</h2>
<p>
  Messages come from a household assistant, on behalf of the two adults who run
  it. The first message in any exchange names the assistant and the household it
  works for. The assistant never claims to be a person. Every message is read
  and approved by a household member before it is sent.
</p>

<h2>What you will receive</h2>
<ul>
  <li>Messages about one specific arrangement — confirming an availability,
      checking a time, following up on something already discussed.</li>
  <li><strong>Message frequency:</strong> a few messages a week at most, and only
      while that arrangement is being settled. An exchange ends after ten
      messages or twenty-four hours, whichever comes first.</li>
  <li>Never marketing, promotion, advertising, or a newsletter. There is nothing
      to subscribe to.</li>
</ul>

<h2>Cost</h2>
<p>
  <strong>Message and data rates may apply.</strong> Your mobile carrier may
  charge you for messages you send or receive. Carriers are not liable for
  delayed or undelivered messages.
</p>

<h2>Stopping</h2>
<p>
  Reply <code>STOP</code> to any message to end messaging immediately and
  permanently. Only you can reverse it, by replying <code>START</code>. Reply
  <code>HELP</code> for help. Ending messages here does not end any other way the
  household reaches you.
</p>

<h2>Your information</h2>
<p>
  Mobile numbers are never sold, rented, or shared with third parties or
  affiliates for marketing or promotional purposes. See the
  <a href="/privacy">privacy policy</a>.
</p>

<h2>Contact</h2>
<p>
  Reply <code>HELP</code> to any message, or contact the household member who
  asked you for this number.
</p>`,
)

/** `GET /terms` — the terms URL named on the A2P 10DLC campaign registration. */
export function handleTerms(c: Context): Response {
  return c.html(TERMS)
}
