# Outline toolbar: three icon menus

A small change, approved 2026-11-22. It goes on the `omeka-import` branch.

## Why

The outline's toolbar has grown to more than eight text buttons that wrap over several rows above the stop list. The user wants them sorted into three icon buttons that show their options on demand.

## What the user asked for

- An **Add** icon. Its options are Add stop, Add text overlay, Add image, Add audio and Record audio.
- An **Import** icon. Its only option is Import from Omeka.
- An **Edit** icon. Its options are Up, Down and Delete.
- Each option is an icon, and its name shows on hover.
- Hovering a menu icon reveals its options. They expand out from the left as they fade in.
- **Edit** is disabled when no stop or overlay is selected.

## Calls made in the design, which the user approved

- **Not just hover.** A menu also opens on keyboard focus, and click or tap toggles it. Only one menu is open at a time. It closes when the pointer leaves the trigger-and-options group, when focus leaves the group, and on Esc. Esc also returns focus to the trigger. Clicking an option does not close its menu, so Up can be pressed several times in a row.
- **Recording controls stay visible.** While recording, or while the microphone permission prompt is up, **Stop and add recording** (recording only) and **Discard** show as ordinary buttons in the toolbar row, after the three icons and outside every menu. **Record audio** stays in the Add menu, disabled while recording is in progress.
- **Option rules are unchanged.**
  - Each option keeps its current enable rule.
  - Up and Down still need a selected stop. With an overlay selected, Edit opens but only Delete is enabled.
  - If the selection clears while Edit is open, Edit closes.
  - Import from Omeka keeps its rule that it is enabled while the panel is open.
- **The Add and Import icons are always enabled.** Add stop is always possible, and Import holds the Omeka toggle, which can also close the panel.
- **Name labels stay inside the pane.** The outline is its own scroll box (`overflow-y: auto`), so anything sticking out of it would be clipped.
  - Each option's name appears just below it on hover and on keyboard focus.
  - The last option of a multi-option row anchors its label to its right edge, so the label can't run past the pane.
  - Options carry `aria-label` but no `title`, because a native tooltip would duplicate the label. The three triggers keep `title`. This change was made in review.
- **The options row hangs below its trigger.** In review this replaced the first call, which laid the row over the toolbar.
  - The row sits at `top: 100%` of its group, starting at the trigger's left edge, and expands to the right over the top of the stop list.
  - An overlaying row had covered the neighbouring triggers, so the pointer couldn't move straight from Add to Import.
- **Clicks.** A trigger click opens its menu, or keeps it open if hover or focus already opened it.
  - A clicked-open menu stays open when the pointer leaves it, and hovering another trigger doesn't take over. This was added at the user's request on 2026-11-22.
  - It closes on a second click of its trigger, when focus moves outside its group, on a press anywhere outside its group, or on Esc.
  - The outside-press check is there because Safari doesn't focus a clicked button, so focusout alone would miss it.
- **Recording closes the Add menu.** Starting a recording closes Add, so at narrow widths the hanging row can't cover Stop and Discard when they wrap to a second row.
- **Icons are inline SVG**, drawn in the template, with `stroke="currentColor"` and `aria-hidden="true"`. No package is added.
- **Motion.**
  - Options animate from `opacity: 0; transform: translateX(-0.5rem) scaleX(0.6)`, with `transform-origin: left`, to rest.
  - Each takes about 160 ms with ease-out, staggered by about 30 ms per option.
  - With `prefers-reduced-motion: reduce`, options only fade.
- **Closed options stay in the DOM**, hidden and `inert`. Every existing `data-*` hook (`data-add-stop`, `data-move-up`, `data-omeka-open`, and so on) keeps working, so the existing tests run unchanged.

## Non-goals

- No new actions.
- No changes to what any action does.
- No changes to the Omeka panel itself.
