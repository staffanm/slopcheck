import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Optional, Union
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from .model import get_model, ClaimClassifier
except ImportError:
    from model import get_model, ClaimClassifier

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("slopcheck.api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Preload the ONNX model and tokenizer on startup
    try:
        model = get_model()
        app.state.model = model
        logger.info(f"Loaded classifier model: {model.model_name} (version {model.model_version})")
    except Exception as e:
        logger.error(f"Failed to preload model: {e}")
        app.state.model = None
    yield


app = FastAPI(
    title="slopcheck Legal Claim Classification API",
    description="Backend API for 4-way Swedish legal citation verification and natural language inference",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SourceItem(BaseModel):
    citation: Optional[str] = Field(default=None, description="Citation string, e.g. 'prop. 2008/09:232 s. 25'")
    text: str = Field(..., description="Resolved passage or section text")
    unit_type: Optional[str] = Field(default="unknown", description="Unit type, e.g. 'statute_provision', 'case_judgment'")


class MatchRequest(BaseModel):
    claim: str = Field(..., description="The legal assertion or statement extracted from the document")
    sources: Union[list[SourceItem], list[dict[str, Any]], list[str]] = Field(
        default_factory=list,
        description="Array of candidate source passage texts or structured source objects"
    )
    unresolved_sources: Optional[list[str]] = Field(
        default_factory=list,
        description="Citations that failed to resolve cleanly to cited units"
    )


class Comparison(BaseModel):
    source: str
    scores: dict[str, float]
    confidence: Optional[float] = None
    margin: Optional[float] = None
    predicted_class: Optional[str] = None
    abstain_reason: Optional[str] = None
    token_length: Optional[int] = None
    unresolved_sources: Optional[list[str]] = None


class MatchResponse(BaseModel):
    label: str = Field(..., description="Verdict label: correct, incorrect, unsupported, misleading, nonsensical, or abstain")
    status: str = Field(..., description="Internal status: correct, incorrect, missing, misleading, nonsensical, or abstain")
    swedish_label: str = Field(..., description="Swedish UI label: Stöd hittat, Möjlig motsägelse, Stöd saknas, Vilseledande, Meningslöst, Kunde inte bedömas")
    reason: str = Field(..., description="Human-readable explanation of the verdict")
    evidence: Optional[Any] = Field(default=None, description="The most significant evidence passage or input premise")
    comparisons: list[Comparison] = Field(default_factory=list, description="Score breakdown and diagnostic metrics")
    model: str = Field(..., description="Model identifier used for inference")
    model_version: Optional[str] = Field(default=None, description="Dataset and model release version")


def handle_match(request: MatchRequest) -> MatchResponse:
    classifier: ClaimClassifier = getattr(app.state, "model", None)
    if classifier is None:
        classifier = get_model()
        app.state.model = classifier

    # Convert Pydantic SourceItem models to dicts if needed
    raw_sources = []
    for s in request.sources:
        if isinstance(s, BaseModel):
            raw_sources.append(s.model_dump())
        else:
            raw_sources.append(s)

    result = classifier.predict_claim(
        claim=request.claim,
        sources=raw_sources,
        unresolved_sources=request.unresolved_sources
    )

    comparisons_parsed = []
    for c in result.get("comparisons", []):
        comparisons_parsed.append(Comparison(**c))

    return MatchResponse(
        label=result["label"],
        status=result["status"],
        swedish_label=result["swedish_label"],
        reason=result["reason"],
        evidence=result.get("evidence"),
        comparisons=comparisons_parsed,
        model=result["model"],
        model_version=result.get("model_version"),
    )


@app.post("/match", response_model=MatchResponse)
@app.post("/api/match", response_model=MatchResponse)
@app.post("/api/semantic", response_model=MatchResponse)
async def match(request: MatchRequest):
    return handle_match(request)


@app.get("/health")
@app.get("/api/health")
async def health():
    classifier: Optional[ClaimClassifier] = getattr(app.state, "model", None)
    is_loaded = classifier is not None and classifier.session is not None
    return {
        "status": "healthy",
        "model": classifier.model_name if classifier else None,
        "model_version": classifier.model_version if classifier else None,
        "loaded": is_loaded,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("backend.main:app", host="0.0.0.0", port=port, reload=False)
