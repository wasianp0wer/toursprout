"""Tour schema. This module is the single source of truth for the data model.

The frontend's TypeScript interfaces mirror the JSON Schema these models
export, so the contract cannot drift between the two halves of the app.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


class Strict(BaseModel):
    """Reject unknown keys everywhere: a typo in hand-authored content is a bug."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LngLat(Strict):
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]


SCHEMA_VERSION = 5


class GeoAnchor(Strict):
    """Where an overlay sits in the world.

    `altitude_m` is metres ABOVE LOCAL GROUND, not above the ellipsoid.
    Passing it raw to mapillary's `geodeticToEnu`, which wants an absolute
    height, once put the Fairfax photographs 128 m underground; the frontend's
    `geodeticAltitude()` adds the local ground reference back. The datum is
    also the one AR needs, since a phone knows its height above the pavement.
    """

    type: Literal["geo"] = "geo"
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    altitude_m: float = Field(default=0.0, alias="altitudeM")


# One member today, so this is a plain alias: pydantic's `discriminator`
# requires an actual union and errors on a single type. Do not "simplify" the
# `Anchor` name away in favour of `GeoAnchor` at the use site: the field that
# holds an anchor says `Anchor` so that adding the image-anchored variant is a
# one-line change here, at the alias, rather than an edit to the field. It becomes
# `Annotated[GeoAnchor | ImageAnchor, Field(discriminator="type")]` when the
# image-anchored variant (pixel coordinates within one panorama) lands. `type`
# is already present and literal, so that change is additive.
Anchor = GeoAnchor


class MarkerDisplay(Strict):
    """A point in the scene the visitor clicks. Rendered as a mapillary-js
    SimpleMarker, and as a pin on the map."""

    mode: Literal["marker"] = "marker"
    icon: Literal["note", "photo", "audio", "place"] = "note"


class InWorldDisplay(Strict):
    """A flat plane standing in the world, drawn by three.js.

    `heading_deg` is the compass direction the face looks toward. `opacity` is
    the value the stop OPENS at; the visitor's slider moves from there.
    """

    mode: Literal["inWorld"] = "inWorld"
    opacity: Annotated[float, Field(ge=0.0, le=1.0)] = 0.7
    heading_deg: Annotated[float, Field(ge=0.0, lt=360.0)] = Field(alias="headingDeg")
    width_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="widthM")
    height_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="heightM")


class AmbientDisplay(Strict):
    """Heard but not seen: audio belonging to the stop as a whole."""

    mode: Literal["ambient"] = "ambient"
    autoplay: bool = True


Display = Annotated[
    MarkerDisplay | InWorldDisplay | AmbientDisplay,
    Field(discriminator="mode"),
]


def _not_blank(v: str) -> str:
    if not v.strip():
        raise ValueError("must not be blank")
    return v


# A required string that is also not just spaces. v1 repeated a
# `@field_validator("source", "url", "license")` block per class; as an
# annotated type the rule is declared once and read at each use site.
NonBlank = Annotated[str, Field(min_length=1), AfterValidator(_not_blank)]


def _safe_media_ref(v: str) -> str:
    """A media reference is a relative POSIX path inside `media/`, nothing else.

    The document points at a stored file in two places — an overlay's
    `mediaId` and a stop's `cachedMediaId` — and through v2 neither was
    checked at all, so `../../etc/passwd` was a valid document. Nothing joined
    them to a path server-side, so this closed no live hole; it is here
    because an unconstrained reference is the kind of thing an importer
    (Omeka, an archive) supplies, and because tightening it later would
    reject documents already written.

    Note what this does NOT say: the file need not exist. `missing_media`
    answers that, against a real directory; a schema cannot.
    """
    if v != v.strip():
        raise ValueError("must not have leading or trailing whitespace")
    if "\\" in v:
        raise ValueError("must use / as its separator, not a backslash")
    if v.startswith("/"):
        raise ValueError("must be relative to media/, not absolute")
    parts = v.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError("must not contain an empty, '.' or '..' path segment")
    if v.startswith("media/"):
        raise ValueError(
            "is already relative to media/, so it must not repeat the prefix"
        )
    return v


# A reference to a file under a tour's `media/` directory.
MediaRef = Annotated[
    str, Field(min_length=1), AfterValidator(_not_blank), AfterValidator(_safe_media_ref)
]


class OriginalCredit(Strict):
    """The author's own work: a recording, a photograph they took.

    There is no URL to give, which is exactly why v1's single Credit shape
    could not express it and the editor could not save.
    """

    type: Literal["original"] = "original"
    creator: NonBlank
    license: NonBlank


class SourcedCredit(Strict):
    """Something obtained from somewhere citable: an archive, Mapillary, Omeka."""

    type: Literal["sourced"] = "sourced"
    source: NonBlank
    url: NonBlank
    license: NonBlank
    creator: str | None = None


Credit = Annotated[OriginalCredit | SourcedCredit, Field(discriminator="type")]


# Which presentations each content kind can currently be drawn as.
#
# A rejection here is a RENDERER limitation, not a limit of the model: the
# three axes are independent by design. Supporting world-standing text means
# flipping one cell; adding AR means adding one mode to the rows that can use
# it. Keep this a table rather than a chain of ifs so that stays true.
DISPLAY_MODES_BY_KIND: dict[str, frozenset[str]] = {
    "text": frozenset({"marker"}),
    "image": frozenset({"marker", "inWorld"}),
    "audio": frozenset({"marker", "ambient"}),
}


class Overlay(Strict):
    """One piece of placed content.

    Three independent axes: `kind` is what it is, `anchor` is where it is,
    `display` is how it is drawn. v1 welded the first and the last together,
    which made "the same photograph, as a pin instead" inexpressible.
    """

    id: str = Field(min_length=1)
    kind: Literal["text", "image", "audio"]
    anchor: Anchor
    display: Display
    title: str = Field(min_length=1)
    body: str | None = None
    media_id: MediaRef | None = Field(default=None, alias="mediaId")
    credit: Credit

    @model_validator(mode="after")
    def _payload_matches_kind(self) -> Overlay:
        if self.kind == "text" and not (self.body or "").strip():
            raise ValueError("text overlays require a body")
        if self.kind in ("image", "audio") and not self.media_id:
            raise ValueError(f"{self.kind} overlays require a mediaId")
        allowed = DISPLAY_MODES_BY_KIND.get(self.kind)
        if allowed is None:
            raise ValueError(f"no display modes are configured for kind {self.kind!r}")
        if self.display.mode not in allowed:
            raise ValueError(
                f"{self.kind} overlays cannot be displayed as "
                f"{self.display.mode!r}; this renderer supports "
                f"{', '.join(sorted(allowed))}"
            )
        return self


class TourDefaults(Strict):
    """Pre-fills an OriginalCredit when the author adds their own work, so
    recording a clip does not mean retyping your own name."""

    creator: NonBlank
    license: NonBlank


class Panorama(Strict):
    """The street-level image a stop is seen from.

    `cached_media_id` is a `MediaRef` like an overlay's `media_id`, and was
    v2's `cachedPath`. The rename is the point: v2 stored `media/pano/x.jpg`,
    a path with the directory baked in, which put a cached panorama outside
    the one namespace the reference checks look at. `orphan_ids` and
    `missing_media` collected only overlay `media_id`s, so the shipped
    example's six cached panoramas were reported as unreferenced orphans
    forever while being, in fact, referenced by six stops.
    """

    provider: Literal["mapillary"]
    image_id: str = Field(min_length=1, alias="imageId")
    bearing: Annotated[float, Field(ge=0.0, lt=360.0)]
    cached_media_id: MediaRef | None = Field(default=None, alias="cachedMediaId")


class Stop(Strict):
    id: str = Field(min_length=1)
    order: Annotated[int, Field(ge=1)]
    title: str = Field(min_length=1)
    summary: str = Field(min_length=1)
    location: LngLat
    osm_ref: str | None = Field(default=None, alias="osmRef")
    panorama: Panorama
    overlays: list[Overlay] = Field(default_factory=list)


class Attribution(Strict):
    """A tour-level line of credit: map data, imagery, an institution.

    `url` is nullable for the same reason `OriginalCredit` exists (ADR 0001):
    a line with nothing to link to is ordinary, and making the URL required
    is exactly how v1's single credit shape became unsatisfiable. Absent is
    `None`; `""` is a field someone failed to fill in, and is refused. The
    licence is never optional — provenance is the point of the field.
    """

    text: NonBlank
    url: NonBlank | None = None
    license: NonBlank


# --- the theme ---------------------------------------------------------------
#
# Lives in the document, not in config.json: config.json is derived state and
# is excluded from an exported bundle, so a theme kept there would not travel
# with the tour. Everything an author can store is an enumerated name or a hex
# colour; nothing is free-form, so a theme can never carry markup, `url(...)`
# or a stray `;` into the stylesheet it is eventually written into.

# Six digits and a hash, one spelling: no `#fff`, no named colours, no `rgb()`.
# Upper case is accepted and stored lower-cased, so a hand-authored `#FFF000`
# is not a frustrating refusal but tour.json still holds exactly one spelling.
HexColor = Annotated[
    str,
    Field(pattern=r"^#[0-9a-fA-F]{6}$"),
    AfterValidator(lambda v: v.lower()),
]


class ThemeOverrides(Strict):
    """The thirteen colours an author may set. Every one is nullable and absent
    by default, so an untouched token is not stored and a later improvement to
    a preset's palette still reaches a tour that merely picked that preset."""

    paper: HexColor | None = None
    panel: HexColor | None = None
    ink: HexColor | None = None
    accent: HexColor | None = None
    wayfinding: HexColor | None = None
    destination: HexColor | None = None
    soft: HexColor | None = None
    muted: HexColor | None = None
    rule: HexColor | None = None
    chip: HexColor | None = None
    chip_selected: HexColor | None = Field(default=None, alias="chipSelected")
    attribution_bar: HexColor | None = Field(default=None, alias="attributionBar")
    on_accent: HexColor | None = Field(default=None, alias="onAccent")


class Theme(Strict):
    """Only names of things we serve are enumerated: a type pairing names font
    files in our own bundle and a layout names a grid we have laid out, so both
    are Literals. Colour is not a file, so colour is free (within HexColor).
    The defaults are Nocturne with no overrides, today's appearance, which is
    what an absent `Tour.theme` means."""

    preset: Literal["nocturne", "archival", "civic", "fieldNotes"] = "nocturne"
    type_pairing: Literal[
        "georgia", "garamond", "franklin", "plex", "franklinGaramond"
    ] = Field(default="georgia", alias="typePairing")
    type_scale: Literal["compact", "comfortable", "generous"] = Field(
        default="comfortable", alias="typeScale"
    )
    layout: Literal["widePanel", "panelLeft", "immersive"] = "widePanel"
    overrides: ThemeOverrides = Field(default_factory=ThemeOverrides)


def _is_png(v: str) -> str:
    if not v.lower().endswith(".png"):
        raise ValueError("must be a .png file")
    return v


class Tour(Strict):
    id: str = Field(min_length=1)
    schema_version: Literal[5] = Field(alias="schemaVersion")
    title: str = Field(min_length=1)
    description: str
    defaults: TourDefaults | None = None
    theme: Theme | None = None
    icon: Annotated[MediaRef, AfterValidator(_is_png)] | None = None
    attribution: list[Attribution] = Field(default_factory=list)
    stops: list[Stop] = Field(min_length=1)

    @model_validator(mode="after")
    def _stops_are_well_ordered(self) -> Tour:
        orders = sorted(s.order for s in self.stops)
        if orders != list(range(1, len(orders) + 1)):
            raise ValueError("stop orders must be contiguous starting at 1")
        return self

    @model_validator(mode="after")
    def _ids_are_unique(self) -> Tour:
        """Stop ids and overlay ids are ONE namespace, unique tour-wide.

        Overlay ids were unchecked through v2, and the editor was the only
        thing keeping them apart: `allIds()` in `document-ops.ts` allocates
        from the combined pool, and `mapOverlay`, `findOverlay` and
        `deleteOverlay` all match an id across EVERY stop rather than within
        one. So two stops sharing an overlay id meant editing or deleting one
        of them silently hit both, and an imported bundle could carry that.

        Enforced here rather than left to the editor because an importer is
        the likely source: ids minted from someone else's identifiers (an
        Omeka item, an archive accession) collide in ways hand-authoring does
        not. v3 migration renames collisions rather than refusing them, so
        a document that predates this rule still opens.
        """
        stop_ids = [s.id for s in self.stops]
        if len(stop_ids) != len(set(stop_ids)):
            raise ValueError("stop ids must be unique")
        overlay_ids = [o.id for s in self.stops for o in s.overlays]
        repeated = sorted({i for i in overlay_ids if overlay_ids.count(i) > 1})
        if repeated:
            raise ValueError(
                "overlay ids must be unique across the whole tour, not only "
                f"within a stop; repeated: {', '.join(repeated)}"
            )
        shared = sorted(set(stop_ids) & set(overlay_ids))
        if shared:
            raise ValueError(
                "stop and overlay ids are one namespace; these name both a "
                f"stop and an overlay: {', '.join(shared)}"
            )
        return self


def referenced_media(tour: Tour) -> set[str]:
    """Every file under `media/` the document points at.

    Both ways a document can name a stored file, collected in one place,
    because the bug this exists to prevent was two collectors that each knew
    about only one of them: `media_store.orphan_ids` and
    `bundle._media_sets` both read overlay `mediaId` and neither read a
    stop's cached panorama. So the shipped example's six panoramas were
    reported as unreferenced orphans while six stops referenced them, and a
    bundle missing a panorama imported clean. A new `MediaRef` field belongs
    here and nowhere else. The tour's own `icon` is one: it is not on a stop
    or an overlay, but it is a file under `media/` all the same.
    """
    refs = {o.media_id for s in tour.stops for o in s.overlays if o.media_id}
    refs |= {
        s.panorama.cached_media_id
        for s in tour.stops
        if s.panorama.cached_media_id
    }
    if tour.icon:
        refs.add(tour.icon)
    return refs
