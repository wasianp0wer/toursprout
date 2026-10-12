import { Component, computed, inject } from '@angular/core';
import { creditLine } from '../core/credit';
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

          @let line = credit(selected.credit);
          <p class="credit">
            @if (line.url) {
              <a [href]="line.url" target="_blank" rel="noopener">{{ line.attribution }}</a>
            } @else {
              {{ line.attribution }}
            }
          </p>
        </article>
      }

      @if (store.hasInWorldOverlays()) {
        <div class="rephoto-control">
          <p class="rephoto-heading">Then and now</p>
          @for (photo of store.inWorldOverlays(); track photo.id) {
            <div class="rephoto-slider" data-rephoto-slider>
              <label [for]="'opacity-' + photo.id">{{ photo.title }}</label>
              <div class="slider-row">
                <span>now</span>
                <input
                  [id]="'opacity-' + photo.id"
                  data-rephoto-opacity
                  [attr.data-rephoto-id]="photo.id"
                  type="range"
                  min="0" max="1" step="0.01"
                  [value]="store.opacityFor(photo.id)"
                  (input)="onOpacity(photo.id, $event)"
                />
                <span>then</span>
              </div>
            </div>
          }
        </div>
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
  protected readonly credit = creditLine;

  protected onOpacity(id: string, event: Event): void {
    this.store.setOverlayOpacity(id, Number((event.target as HTMLInputElement).value));
  }

  protected readonly position = computed(
    () => `${this.store.currentIndex() + 1} of ${this.store.stops().length}`,
  );
}
