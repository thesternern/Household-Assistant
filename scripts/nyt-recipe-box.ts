/**
 * List every recipe saved in a NYT Cooking recipe box, ready to hand to Chessy.
 *
 *   NYT_USER_ID=12345678 NYT_COOKIE='nyt-a=…; NYT-S=…' npm run nyt:recipe-box
 *
 * Run this on your own machine, never on the server. It talks to NYT and writes
 * a text file; it does not touch the database, and the credentials it reads stay
 * in the shell you typed them into — nothing is written back to `.env` and the
 * cookie is never logged.
 *
 * The output is grouped into batches sized for `recipe_import_urls`, so the
 * workflow is: run this, paste one batch into Telegram, repeat. Chessy fetches
 * and parses each page itself through the ordinary scraper — the recipe pages
 * are public, so only this listing step needs your login.
 *
 * Where the two values come from: sign in at cooking.nytimes.com/recipe-box,
 * open the browser's developer tools, Network tab, and reload. Click any request
 * to `/api/v2/…`. `NYT_USER_ID` is the number in its path
 * (`/api/v2/users/12345678/…`); `NYT_COOKIE` is the whole `cookie` request
 * header, copied verbatim. Both expire — when they do, this script says so.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fetchRecipeBoxLinks } from '../src/recipes/nyt-box.js'

/** Matches MAX_IMPORT_BATCH in `src/tools/recipes.ts`. */
const BATCH_SIZE = 25

const OUTPUT_FILE = 'nyt-recipe-box.txt'

const SETUP_HELP = `
Set both of these before running, from a browser signed in to NYT Cooking:

  1. Open https://cooking.nytimes.com/recipe-box
  2. Developer tools → Network tab → reload the page
  3. Click any request to /api/v2/… then read off:
       NYT_USER_ID  the number in the request path, /api/v2/users/<HERE>/…
       NYT_COOKIE   the whole "cookie" request header, copied verbatim

Then:

  NYT_USER_ID=12345678 NYT_COOKIE='nyt-a=…; NYT-S=…' npm run nyt:recipe-box

Neither value is stored anywhere by this script.
`

async function main(): Promise<void> {
  const userId = process.env['NYT_USER_ID']?.trim()
  const cookie = process.env['NYT_COOKIE']?.trim()

  if (!userId || !cookie) {
    console.error(`Missing ${!userId ? 'NYT_USER_ID' : 'NYT_COOKIE'}.${SETUP_HELP}`)
    process.exit(1)
  }

  console.error('Reading your NYT Cooking recipe box…')
  const links = await fetchRecipeBoxLinks({ userId, cookie })

  if (links.length === 0) {
    console.error('That recipe box is empty. If you know it is not, the cookie is probably stale.')
    return
  }

  const path = resolve(OUTPUT_FILE)
  await writeFile(path, links.join('\n') + '\n', 'utf-8')

  const batches = Math.ceil(links.length / BATCH_SIZE)
  for (let i = 0; i < batches; i++) {
    const batch = links.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
    console.log(`\n─── batch ${i + 1} of ${batches} (${batch.length} recipes) ───`)
    console.log(batch.join('\n'))
  }

  console.error(
    `\nFound ${links.length} saved recipes, written to ${path}.\n` +
      `Paste one batch at a time to Chessy: "import these recipes", then the batch.\n` +
      `${OUTPUT_FILE} holds your saved recipe list — delete it when you are done.`,
  )
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
