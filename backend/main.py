import os
from contextlib import asynccontextmanager
from typing import Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:
    from .model import get_model, NLIModel
    from .semantic import evaluate_semantic
except ImportError:
    from model import get_model, NLIModel
    from semantic import evaluate_semantic

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Preload the model on startup
    model = get_model()
    app.state.model = model
    yield

app = FastAPI(
    title="slopcheck Semantic Matching API",
    description="Backend API for Swedish legal citation semantic matching and natural language inference",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class MatchRequest(BaseModel):
    claim: str = Field(..., description="The legal assertion or statement extracted from the document")
    sources: list[str] = Field(default_factory=list, description="Array of candidate source passage texts from legal sources")
    thresholds: Optional[dict[str, float]] = Field(default=None, description="Optional custom threshold overrides")

class Comparison(BaseModel):
    source: str
    scores: dict[str, float]

class MatchResponse(BaseModel):
    label: str = Field(..., description="Verdict label: correct, incorrect, unsupported, nonsensical, or abstain")
    status: str = Field(..., description="Slopcheck internal status: correct, incorrect, missing, nonsensical, or abstain")
    swedish_label: str = Field(..., description="Swedish UI label: Stöd hittat, Möjlig motsägelse, Stöd saknas, Meningslöst, Kunde inte bedömas")
    reason: str = Field(..., description="Human-readable explanation of the verdict")
    evidence: Optional[Comparison] = Field(default=None, description="The most significant evidence passage")
    comparisons: list[Comparison] = Field(default_factory=list, description="Detailed score breakdown for every compared source passage")
    model: str = Field(..., description="Model identifier used for inference")

def handle_match(request: MatchRequest) -> MatchResponse:
    model: NLIModel = app.state.model
    result = evaluate_semantic(
        claim=request.claim,
        sources=request.sources,
        predict_fn=model.predict_batch,
        thresholds=request.thresholds,
    )
    return MatchResponse(
        label=result["label"],
        status=result["status"],
        swedish_label=result["swedish_label"],
        reason=result["reason"],
        evidence=Comparison(**result["evidence"]) if result["evidence"] else None,
        comparisons=[Comparison(**c) for c in result["comparisons"]],
        model=model.model_name,
    )

@app.post("/match", response_model=MatchResponse)
@app.post("/api/match", response_model=MatchResponse)
@app.post("/api/semantic", response_model=MatchResponse)
async def match(request: MatchRequest):
    return handle_match(request)

@app.get("/health")
@app.get("/api/health")
async def health():
    model: NLIModel = getattr(app.state, "model", None)
    return {
        "status": "healthy",
        "model": model.model_name if model else None,
        "loaded": model.model is not None if model else False,
    }

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
