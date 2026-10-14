import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The whole application is one of two routed pages — the viewer ('') or the
 * editor ('edit') — so the root component does nothing but host the outlet.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
