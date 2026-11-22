# Outline Toolbar Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outline toolbar's row of text buttons with three icon menus: Add, Import and Edit.

**Architecture:** This lives entirely in `OutlinePane`. A single `openMenu` signal holds `'add' | 'import' | 'edit' | null`. Each menu is a group containing a trigger button and its option row. The option buttons are the existing buttons, made icon-only, with their `data-*` hooks and handlers unchanged.

**Tech Stack:** Angular 22 standalone components with signals, and vitest via `ng test`. Node 24 is pinned; see the Makefile.

**Spec:** `docs/superpowers/specs/2026-11-22-outline-toolbar-menus-design.md`

## Global Constraints

- Every existing `outline-pane.spec.ts` test passes without being edited.
- Every existing `data-*` hook stays on the same action.
- Trigger hooks:
  - `data-menu="add"`, `data-menu="import"`, `data-menu="edit"` on the trigger buttons.
  - `data-menu-options="add|import|edit"` on each option row.
- Triggers carry `aria-haspopup="true"` and `aria-expanded`. Their `aria-label` and `title` are exactly "Add", "Import" and "Edit".
- Option `aria-label` and `title` values:
  - "Add stop"
  - "Add text overlay"
  - "Add image"
  - "Add audio"
  - "Record audio"
  - "Import from Omeka"
  - "Move stop up"
  - "Move stop down"
  - "Delete"
- Edit is disabled when `!store.selectedId()`.
- A closed option row has the `inert` attribute and is visually hidden.
- Motion falls back to a fade only under `prefers-reduced-motion: reduce`.
- No new dependencies.

## Review Focus

- **Keyboard-only use.** Tab reaches the trigger, Enter or Space opens it, Tab moves into the options, and Esc closes and returns focus to the trigger.
- **Recording.** While recording, Stop and Discard are visible with every menu closed.
- **Selection clearing while Edit is open.** Edit closes and its trigger disables.
- **A narrow sidebar (15rem).** The Add option row fits without horizontal scrolling of the pane.
- **Name labels.** They are not clipped by the pane's scroll box.

---

### Task 1: Icon menus in the outline toolbar

**Files:**
- Modify: `frontend/src/app/editor/outline-pane.html`
- Modify: `frontend/src/app/editor/outline-pane.ts`
- Modify: `frontend/src/app/editor/outline-pane.css`
- Test: `frontend/src/app/editor/outline-pane.spec.ts`

**Depends on:** nothing. It is the only task, so there is no parallelism.

**Interfaces:**
- Produces, protected:
  - `openMenu = signal<'add' | 'import' | 'edit' | null>(null)`
  - `toggleMenu(m)`
  - `openMenuOn(m)` for mouseenter and focusin
  - `closeMenu(m)` for mouseleave, and for a focusout whose `relatedTarget` is outside the group
  - an Esc keydown on the group, which closes the menu and focuses the trigger

  These names are a suggestion; the implementer may adjust them.

- [ ] **Step 1: Write failing tests** in a new `describe('toolbar menus')` block:
  - `there are three menu triggers labelled Add, Import and Edit` — check `aria-label` on each `[data-menu]`.
  - `options are closed and inert until their menu opens` — `[data-menu-options="add"]` has `inert` and the `add` trigger has `aria-expanded="false"`. Clicking `[data-menu="add"]` gives `aria-expanded="true"` and no `inert`.
  - `hovering a trigger group opens its menu, leaving closes it` — dispatch `mouseenter` and `mouseleave` on the group element.
  - `focus inside a group opens it, Escape closes it and returns focus to the trigger`.
  - `opening one menu closes the other`.
  - `Edit is disabled with nothing selected, enabled for a stop or an overlay` — Up and Down are disabled for an overlay, and Delete is enabled.
  - `clearing the selection closes an open Edit menu`.
  - `while recording, Stop and Discard show outside every menu` — use `installRecording` as the existing recording tests do. Check that `[data-record-stop]` and `[data-record-cancel]` are not inside any `[data-menu-options]`.
  - `every option is icon-only with its name as aria-label and title` — each option has an `svg[aria-hidden="true"]` and the exact labels from Global Constraints.

- [ ] **Step 2: Run them, and expect failures.**
  Run: `cd frontend && PATH=/Users/maddiepersonal/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH npx ng test --watch=false --include src/app/editor/outline-pane.spec.ts`

- [ ] **Step 3: Implement** the template, the signal and handlers, and the CSS. The CSS covers:
  - the absolutely positioned option row, with the pane background, starting at the trigger's right edge;
  - name labels shown below each option on `:hover` and `:focus-visible`;
  - staggered `--i` transitions from `opacity:0; translateX(-0.5rem) scaleX(0.6)`, with `transform-origin:left`, about 160 ms ease-out and about 30 ms stagger;
  - a reduced-motion block that fades only.

  Close Edit when the selection clears, with an `effect` or by computing it in the template.

- [ ] **Step 4: Run the spec, then the full suite** with `make check` from the repo root. Expect all green.

- [ ] **Step 5: Commit** only the four files above, with message "Outline toolbar: Add, Import and Edit icon menus". Do not stage anything else; the working tree holds unrelated uncommitted user edits.
