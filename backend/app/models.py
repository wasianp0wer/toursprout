"""Tour schema. This module is the single source of truth for the data model.

The frontend's TypeScript interfaces mirror the JSON Schema these models
export, so the contract cannot drift between the two halves of the app.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Strict(BaseModel):
    """Reject unknown keys everywhere: a typo in hand-authored content is a bug."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class LngLat(Strict):
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]


class GeoAnchor(Strict):
    """Anchors an overlay to a point in the world rather than to an image.

    `type` is a discriminator with one member today. Image-anchored overlays
    (pinned to pixel coordinates within a single panorama) are the expected
    second variant; modelling the union now keeps that additive.

    Note that `altitude` is carried for the map layer and for future
    image-anchored overlays, but is not consumed by the panorama renderer:
    mapillary-js markers accept longitude and latitude only.
    """

    type: Literal["geo"] = "geo"
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    altitude: float = 0.0


class GeoQuadAnchor(Strict):
    """A photograph standing in the world as a flat plane.

    Used by rephoto overlays, where the historical image is draped over the
    scene it depicts rather than pinned to a point. `heading_deg` is the
    compass direction the face of the photograph looks toward.
    """

    type: Literal["geoQuad"] = "geoQuad"
    lng: Annotated[float, Field(ge=-180.0, le=180.0)]
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    altitude: float = 0.0
    heading_deg: Annotated[float, Field(ge=0.0, lt=360.0)] = Field(alias="headingDeg")
    width_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="widthM")
    height_m: Annotated[float, Field(gt=0.0, le=200.0)] = Field(alias="heightM")


Anchor = Annotated[GeoAnchor | GeoQuadAnchor, Field(discriminator="type")]


class Credit(Strict):
    """Provenance for a single piece of media. Required, never blank."""

    source: str = Field(min_length=1)
    url: str = Field(min_length=1)
    license: str = Field(min_length=1)
    creator: str | None = None

    @field_validator("source", "url", "license")
    @classmethod
    def _not_whitespace(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be blank")
        return v


class Overlay(Strict):
    id: str = Field(min_length=1)
    kind: Literal["text", "image", "audio", "rephoto"]
    anchor: Anchor
    title: str = Field(min_length=1)
    body: str | None = None
    media_id: str | None = Field(default=None, alias="mediaId")
    credit: Credit

    @model_validator(mode="after")
    def _payload_matches_kind(self) -> Overlay:
        if self.kind == "text" and not (self.body or "").strip():
            raise ValueError("text overlays require a body")
        if self.kind in ("image", "audio", "rephoto") and not self.media_id:
            raise ValueError(f"{self.kind} overlays require a mediaId")
        if self.kind == "rephoto" and self.anchor.type != "geoQuad":
            raise ValueError("rephoto overlays require a geoQuad anchor")
        if self.kind != "rephoto" and self.anchor.type != "geo":
            raise ValueError(f"{self.kind} overlays require a geo anchor")
        return self


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
    schema_version: int = Field(alias="schemaVersion")
    title: str = Field(min_length=1)
    description: str
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


class TourSummary(Strict):
    """What `GET /api/tours` returns: enough to list, not the whole document."""

    id: str
    title: str
    description: str
    stop_count: int = Field(alias="stopCount")
