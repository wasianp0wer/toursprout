import { Component, ElementRef, effect, inject, input } from '@angular/core';
import { cssVariablesFor, resolveTheme, type Theme } from '../core/theme';

/**
 * A static lookalike of the viewer, painted from the same resolved tokens, so
 * the author can see a colour or a typeface land without leaving the editor.
 * It is deliberately NOT the real viewer: it has no map, no panorama and no
 * tour, and it can drift from the viewer's own stylesheets. Two things keep it
 * honest: it consumes only token names, and a test asserts those names are all
 * ones the viewer's stylesheets read too. The full-size check remains the
 * editor's Preview link to /view.
 *
 * The host carries `data-type-pairing` and `data-layout`, as the viewer does.
 * That attribute is what makes styles.css hand this subtree --display, --body
 * and --display-weight; the font-family and weight are applied here, in
 * theme-preview.css, because styles.css applies them to the viewer only.
 */
@Component({
  selector: 'app-theme-preview',
  templateUrl: './theme-preview.html',
  styleUrl: './theme-preview.css',
})
export class ThemePreview {
  readonly theme = input<Theme | null | undefined>(null);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => {
      const r = resolveTheme(this.theme());
      const el = this.host.nativeElement;
      for (const [name, value] of Object.entries(cssVariablesFor(r))) {
        el.style.setProperty(name, value);
      }
      // Not a colour, so cssVariablesFor does not carry it.
      el.style.setProperty('--type-scale', String(r.scaleFactor));
      // The resolved values, never the stored ones: an unrecognised name must
      // not leave the host with an attribute no styles.css rule matches.
      el.setAttribute('data-layout', r.layout);
      el.setAttribute('data-type-pairing', r.typePairing);
    });
  }
}
