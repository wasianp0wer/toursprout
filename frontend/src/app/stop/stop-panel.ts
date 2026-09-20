import { Component, computed, inject } from '@angular/core';
import { TourApi } from '../core/tour-api';
import { TourStore } from '../core/tour-store';

@Component({
  selector: 'app-stop-panel',
  styleUrl: './stop-panel.css',
  template: `
    @let stop = store.currentStop();
    @if (stop) {
      <header>
        <p class="position">{{ position() }}</p>
        <h2>{{ stop.title }}</h2>
        <p class="summary">{{ stop.summary }}</p>
      </header>

      <nav class="overlay-list">
        @for (ov of store.overlaysForCurrentStop(); track ov.id) {
          <button
            type="button"
            data-overlay-item
            [class.active]="ov.id === store.selectedOverlay()?.id"
            (click)="store.selectOverlay(ov.id)"
          >
            <span class="kind">{{ ov.kind }}</span>{{ ov.title }}
          </button>
        }
      </nav>

      @let selected = store.selectedOverlay();
      @if (selected) {
        <article class="overlay-detail">
          <h3>{{ selected.title }}</h3>

          @switch (selected.kind) {
            @case ('text') {
              <p>{{ selected.body }}</p>
            }
            @case ('image') {
              <img [src]="api.mediaUrl(selected.mediaId!)" [alt]="selected.title" />
            }
            @case ('audio') {
              <audio controls preload="none" [src]="api.mediaUrl(selected.mediaId!)"></audio>
            }
          }

          <p class="credit">
            {{ selected.credit.source }}@if (selected.credit.creator) { — {{ selected.credit.creator }}} ·
            {{ selected.credit.license }}
          </p>
        </article>
      }

      <footer class="controls">
        <button type="button" data-prev [disabled]="!store.hasPrevious()" (click)="store.previous()">
          Previous
        </button>
        <button type="button" data-next [disabled]="!store.hasNext()" (click)="store.next()">
          Next
        </button>
      </footer>
    }
  `,
})
export class StopPanel {
  protected readonly store = inject(TourStore);
  protected readonly api = inject(TourApi);

  protected readonly position = computed(
    () => `${this.store.currentIndex() + 1} of ${this.store.stops().length}`,
  );
}
