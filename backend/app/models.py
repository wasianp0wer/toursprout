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


SCHEMA_VERSION = 2


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
# requires an actual union and errors on a single type. It becomes
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
    media_id: str | None = Field(default=None, alias="mediaId")
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
    provider: Literal["mapillary"]
    image_id: str = Field(min_length=1, alias="imageId")
    bearing: Annotated[float, Field(ge=0.0, lt=360.0)]
    cached_path: str | None = Field(default=None, alias="cachedPath")


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
    text: str = Field(min_length=1)
    url: str
    license: str


class Tour(Strict):
    id: str = Field(min_length=1)
    schema_version: Literal[2] = Field(alias="schemaVersion")
    title: str = Field(min_length=1)
    description: str
    defaults: TourDefaults | None = None
    attribution: list[Attribution] = Field(default_factory=list)
    stops: list[Stop] = Field(min_length=1)

    @model_validator(mode="after")
    def _stops_are_well_ordered(self) -> Tour:
        ids = [s.id for s in self.stops]
        if len(ids) != len(set(ids)):
            raise ValueError("stop ids must be unique")
        orders = sorted(s.order for s in self.stops)
        if orders != list(range(1, len(orders) + 1)):
            raise ValueError("stop orders must be contiguous starting at 1")
        return self
