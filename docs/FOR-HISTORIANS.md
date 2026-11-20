# Building a walking tour: what you need to know

You will build a walking tour in your web browser, with nothing to install. This
is a test: we want to hear what works and what does not. Anything odd you meet
is useful to us, so please report it (the last section says how).

**Where:** **[URL — filled in before this page is sent]**
**Sign-in:** the browser will ask for a username and password once. They are
the same for everyone: **[username]** and **[password]**. Use Edge or Chrome.

## Your recovery key: write it down first

When you start or open a tour, a **Recovery key** appears at the top of the
editing page, next to a **Copy** button. It is sixteen letters and numbers.

The key is the only way back to your tour if your browser forgets who you are.
That happens if you clear your browsing data, switch to a different browser or
computer, or use a private window. Copy it and paste it somewhere safe (an
email to yourself will do), or write it on paper.

To use it, open the address above in the browser that has forgotten you. On
the first screen, under **Recover a tour**, type the key and press **Open it**.
It only works when no tour is open in that browser. Anyone who has the key and
the shared password can open your tour, so treat it like a password. A tour
you have not touched for three months is removed, so export anything you want
to keep (below).

If the old browser still has the tour open, close that tab: after recovering,
both are editing the same tour and the last save wins.

Use **one browser tab** for your tour. Two tabs share it, and whichever saves
last wins.

## Starting

On the first screen you can start **a new empty tour** (give it a title, then
**Start it**), open the **Old Town Fairfax** example to see how a finished tour
is put together, or drag in a tour you already have. Your changes save
themselves; the top of the page says **All changes saved** when they have.

## Choosing the street view for a stop

Click **Find panoramas near here** and the editor lists the street-level
imagery Mapillary has around your stop. Each one is labelled:

- **360°** — a full panorama. A visitor can turn all the way round in it.
- **flat** — an ordinary photograph, usually taken from a phone or a dashcam.

Pick whichever looks right. In many towns outside the United States there is
no 360 coverage at all, and the flat pictures are all there is; a stop built on
one works like any other stop.

**Two things to know about a flat stop.** The view cannot be turned, because
the camera only ever pointed one way — the visitor sees that one direction and
no more. And anything you place outside what the camera was pointed at will be
saved in your tour quite correctly, but will never be visible, because there is
nowhere for the visitor to turn to see it. So put your photographs roughly
where the camera was looking. **The editor will not warn you about this** — we
would rather let you make the stop than get in your way — but the map shows a
pale green wedge spreading out from the camera, and that is the direction it
faced. If there is no wedge, Mapillary does not know which way that picture
was taken, and you will have to judge it from the picture itself. The wedge
appears once the street view has finished loading.

## Recording narration

1. Click a stop in the list on the left, so the editor knows where the
   recording belongs.
2. Click **Record audio**. The very first time, the editor asks who made the
   work and under what licence. Answer once; it is used for everything you add.
3. Your browser will ask to use the microphone. Choose **Allow**.
4. Speak. When you are done, click **Stop and add recording**. (**Discard**
   throws it away.) The recording appears under that stop.

**This feature has never been tried in a real browser.** We are sending it out
anyway, so you are the first to see it. If it does not work, please tell us
(see the last section). The editor will show a message if it cannot reach
your microphone. If you see a yellow note about Safari, you can ignore it unless
you expect people to view your tour in Safari.

## Using a photograph from the Library of Congress

The editor can no longer search the Library of Congress for you. Do the search
yourself, in another tab:

1. Go to **loc.gov**, search, and open the item you want.
2. Download the image to your computer as a **JPEG** (PNG and WebP also work).
   A moderate size is plenty. A file over the limit is refused with a message,
   and a smaller download will do.
3. Back in the editor, click the stop it belongs to and click **Add image**.
   Choose the file. It appears under the stop, ready to place.

### Cite it by hand

The editor no longer fills in the title, the date, the photographer or the
rights. You do. Take them from the item's page on loc.gov, and with the new
photograph selected, fill in the boxes on the right:

- **Title:** the item's title.
- **Credit:** the photographer or creator, and the collection, e.g. "Name,
  Library of Congress".
- **Body:** everything else a reader needs: the date, the call number or
  link back to the loc.gov page, and the **rights statement exactly as the
  record gives it**.

Put the rights statement in the Body even if you also gave a licence earlier.
The licence comes from that first question and is the same for everything you
add; the editor has no box to change it for one photograph.

## Importing from Omeka

If your photographs or recordings are already on an Omeka Classic site, the
editor can bring them in for you, credit and all.

1. Click the stop they belong to, then **Import from Omeka**.
2. Type the site's address under **Site** (the editor remembers it), a word
   to look for under **Find**, and press **Search**.
3. Click an item to see its files, then **Add to this stop** beside the one
   you want. It appears under the stop with the item's title, description,
   creator and rights already filled in.

Some things to know:

- **The site's API must be turned on.** If it is not, the editor says so.
  Someone with an administrator login turns it on in the Omeka admin under
  **Settings → API**.
- **Only public items show up.** An item the site keeps private will not
  appear in a search.
- **Images come in as Omeka's large JPEG**, not the original upload. That is
  plenty for a tour.
- **If the item states no rights,** the editor asks for the licence you are
  adding it under, and **Add to this stop** stays greyed out until you type
  one. Nothing is filled in for you.

## Sending your tour back

Click **Export bundle** at the top. Your browser downloads a `.zip` file with
the whole tour in it, photographs and recordings included. **Email that file**
back to us. Export before you click **Close tour**: closing deletes your tour
from the server, with no undo.

## When something goes wrong

Tell us, even if it seems small. Write to **[contact — filled in before this
page is sent]** with:

- what you were doing and what you expected;
- what happened instead, and any message on the screen, word for word
  (a photograph of the screen is fine);
- which browser you were using.

For a recording that does not work, add whether the browser asked for the
microphone, and what you answered.
