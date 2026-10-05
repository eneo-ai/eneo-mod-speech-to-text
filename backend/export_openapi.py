"""docs/api/openapi.json: the backend's API as OpenAPI 3.1, written from the app's own schema generator.

    cd backend && python export_openapi.py [PATH]

PATH is docs/api/openapi.json at the repository root unless given. Nothing starts: the placeholders below stand in
for the settings the app reads when it is imported (none of them reaches the file), no lifespan runs, no request is
made, and the HTTP client is closed before the script ends. tests/test_openapi.py holds the committed file to a fresh
export and the file's statements to what the app does.

The generator describes the routes the app declares. Here its output is completed with what a signature cannot say (who
may call, what a failure looks like, what an upload must contain) and with the Eneo calls the proxy forwards, one
operation for each entry of ``PROXY_ROUTES``. Every route of the app and every entry of the allowlist must have a text
in ``OPERATIONS`` or ``ENEO_SUMMARIES``: an export without one stops with its name.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import warnings
from copy import deepcopy
from pathlib import Path
from typing import Any, NamedTuple
from unittest import mock

PLACEHOLDERS = {
    "ENEO_BACKEND_URL": "https://eneo.example.org",
    "ENEO_PUBLIC_URL": "https://eneo.example.org",
    "MODULE_PUBLIC_URL": "https://transkribering.example.org",
    "MODULE_KEY": "speech-to-text",
    "ENEO_API_KEY": "placeholder",
    "SESSION_SECRET": "x" * 48,
}

from pydantic import BaseModel  # noqa: E402
from starlette.routing import compile_path  # noqa: E402

# The app reads its settings when it is imported. It reads these and nothing the shell has set, and the environment is
# the shell's again afterwards.
with mock.patch.dict(os.environ, PLACEHOLDERS, clear=True):
    from app import main  # noqa: E402
from app.config import Organization  # noqa: E402
from app.module_auth import SESSION_COOKIE, STATE_COOKIE, ModuleUser  # noqa: E402

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "docs" / "api" / "openapi.json"
# Where Eneo's own description of what these calls take and return is read.
ENEO_CONTRACT_URL = "https://github.com/eneo-ai/eneo"

ERROR = {"$ref": "#/components/schemas/Error"}
PATH_PARAMETERS = {
    "flow_id": "Flödets id i Eneo.",
    "run_id": "Körningens id i Eneo.",
    "step_id": "Stegets id i Eneo.",
    "attempt_id": "Försökets nummer i Eneo.",
    "checkpoint_id": "Granskningspunktens id i Eneo.",
    "file_id": "Filens id i Eneo.",
    "variant": "Vilken logotyp: den för ljust eller för mörkt läge.",
}
QUERY_PARAMETERS = {
    "next": "Sida i modulen att återvända till efter inloggningen: en sökväg som börjar med ett enda snedstreck, "
    "annars `/flows`.",
    "renew": "`true` för en ny inloggning i ett eget fönster för den som är inloggad nu. Utan session är den vägrad "
    "(`fel=utgangen`).",
    "ticket": "Engångsticket från Eneo.",
    "state": "Värdet som inloggningen startade med; det måste vara det som står i kakan `" + STATE_COOKIE + "`.",
    "disposition": "`inline` öppnar bara en PDF i webbläsaren; allt annat, och `attachment`, hämtas som fil.",
}
TAGS = (
    (
        "Inloggning",
        "Modulens egen inloggning mot Eneo. Sessionen är en opak kaka som slås upp i backendprocessen; ingen token når "
        "webbläsaren.",
    ),
    ("Uppladdning", "Filer som modulen tar emot och lämnar vidare till Eneo."),
    ("Filer", "Filer ur en körning, strömmade från modulens egen origin."),
    (
        "Märke",
        "Organisationen och dess accent. Ingen av rutterna kräver session: inloggningssidan visar organisationen före "
        "inloggningen.",
    ),
    ("Hälsa", "Hälsokontroll."),
    (
        "Eneo",
        "Anrop som modulen skickar vidare till Eneo, bara de som tillåtelselistan räknar upp. Begäran och svar är "
        "Eneos: modulen läser och "
        "ändrar inte innehållet, Eneos statuskod går tillbaka som den är och frågeparametrarna skickas vidare. Det som "
        "gäller för en begäran "
        "och ett svar står i Eneos egen beskrivning (se länken). Allt annat under `/api/eneo/` får `403 Eneo resource "
        "is not exposed`. "
        "Av webbläsarens huvuden går bara "
        + ", ".join(
            "`" + "-".join(part.capitalize() for part in name.split("-")) + "`"
            for name in sorted(main._FORWARDED_REQUEST_HEADERS)
        )
        + " vidare; "
        "modulens nyckel och användarens token sätts ur sessionen.",
    ),
)


class Op(NamedTuple):
    """What a route's signature cannot say: its text, who may call it and what it answers besides success."""

    tag: str
    summary: str
    description: str = ""
    session: bool = False  # a valid session, else 401
    origin: bool = False  # Origin is the module's own, else 403
    user: str | None = None  # X-Expected-User: "required" (409 user_changed when not the session's) or "optional"
    success: dict[str, Any] | None = None  # the answers of the route itself, by status
    body: dict[str, Any] | None = None  # the request body
    parameters: tuple[dict[str, Any], ...] = ()  # beside the path and query parameters of the signature
    errors: tuple[str, ...] = ()  # BFF error codes: {"error": code, "detail": ...}
    too_large: str | None = None  # the 413 of the body limit that applies: "max_body_bytes" or "max_upload_bytes"


def reply(
    description: str, content: dict[str, Any] | None = None, headers: dict[str, Any] | None = None
) -> dict[str, Any]:
    answer: dict[str, Any] = {"description": description}
    if headers:
        answer["headers"] = headers
    if content:
        answer["content"] = content
    return answer


def json_of(schema: dict[str, Any]) -> dict[str, Any]:
    return {"application/json": {"schema": schema}}


def header(name: str, description: str, *, required: bool = False) -> dict[str, Any]:
    return {
        "name": name,
        "in": "header",
        "required": required,
        "description": description,
        "schema": {"type": "string"},
    }


REDIRECT = {"Location": {"description": "Dit webbläsaren går härnäst.", "schema": {"type": "string"}}}
# Eneo's answer to a call the module forwards is the module's own: any status Eneo gives, and what Eneo sends.
ENEO_ANSWERS = {
    "200": {"$ref": "#/components/responses/EneoAnswer"},
    "default": {"$ref": "#/components/responses/EneoAnswer"},
}
UPLOAD_BODY = {
    "required": True,
    "description": "Exakt en filpart med namnet `upload_file` och inga andra fält. Filnamn och innehållstyp får sakna "
    "styrtecken (annars 400).",
    "content": {
        "multipart/form-data": {
            "schema": {
                "type": "object",
                "required": ["upload_file"],
                "additionalProperties": False,
                "properties": {"upload_file": {"type": "string", "format": "binary"}},
            }
        }
    },
}
UPLOAD_TIMEOUT = header(
    "X-Upload-Timeout-Seconds",
    "Hur länge modulen väntar på Eneo, i sekunder. Ett värde under 60 räknas som 60, och inget går över "
    "`UPLOAD_PROXY_TIMEOUT_SECONDS`. Läses av modulen och skickas inte vidare.",
)
RANGE = header("Range", "Ett byteintervall, som `bytes=0-1023`. Skickas vidare till Eneo; svaret är då `206`.")
PROXY_ERRORS = ("upstream_unreachable", "upstream_too_large", "upstream_redirect")
UPLOAD_ERRORS = (*PROXY_ERRORS, "upstream_upload_timeout")
STREAM_ERRORS = ("upstream_unreachable", "upstream_redirect", "upstream_invalid")
BFF_ERRORS = sorted({*PROXY_ERRORS, *UPLOAD_ERRORS, *STREAM_ERRORS})


def file_answer(what: str) -> dict[str, Any]:
    return reply(
        f"{what}, strömmad: modulen buffrar den inte. `Cache-Control: private, no-store` och "
        "`X-Content-Type-Options: nosniff`. "
        "Eneos felsvar (till exempel `404`) kommer tillbaka med sin statuskod och sitt `detail`.",
        {"*/*": {"schema": {"type": "string", "format": "binary"}}},
        {"Accept-Ranges": {"schema": {"type": "string"}}, "Content-Range": {"schema": {"type": "string"}}},
    )


OPERATIONS: dict[tuple[str, str], Op] = {
    ("GET", "/health"): Op(
        "Hälsa",
        "Hälsokontroll",
        "Imagens egen kontroll. En riktig rutt: ett trasigt bygge av gränssnittet kan inte svara med en sida.",
        success={"200": reply("Backenden svarar.", json_of({"type": "object", "properties": {"ok": {"const": True}}}))},
    ),
    ("HEAD", "/health"): Op("Hälsa", "Hälsokontroll, bara huvudena", success={"200": reply("Backenden svarar.")}),
    ("GET", "/api/healthz"): Op(
        "Hälsa",
        "Hälsokontroll",
        "Samma svar som `/health`.",
        success={"200": reply("Backenden svarar.", json_of({"type": "object", "properties": {"ok": {"const": True}}}))},
    ),
    ("HEAD", "/api/healthz"): Op("Hälsa", "Hälsokontroll, bara huvudena", success={"200": reply("Backenden svarar.")}),
    ("GET", "/api/branding"): Op(
        "Märke",
        "Organisationen i sidhuvudet",
        "Namnet, om det ska visas, och varje logotyps proportioner så att sidan kan reservera plats.",
        success={"200": reply("Organisationen.", json_of({"$ref": "#/components/schemas/Branding"}))},
    ),
    ("GET", "/api/branding/logo/{variant}"): Op(
        "Märke",
        "Organisationens logotyp",
        "Från modulens egen origin med `nosniff`, `no-cache` och en egen `Content-Security-Policy` som gör att en SVG "
        "som öppnas för sig inte kör något.",
        success={
            "200": reply(
                "Logotypen.",
                {
                    "image/svg+xml": {"schema": {"type": "string"}},
                    "image/png": {"schema": {"type": "string", "format": "binary"}},
                },
            ),
            "404": reply("Ingen logotyp är konfigurerad.", json_of(ERROR)),
        },
    ),
    ("GET", "/api/branding/theme.css"): Op(
        "Märke",
        "Accentfärgens stilmall",
        "Sidan länkar den efter sitt byggda tema. Innehållet är en fast mall med en redan kontrollerad accent, eller "
        "en tom kommentar utan `ORGANIZATION_ACCENT`. "
        "`ETag` och `If-None-Match` ger `304`.",
        success={
            "200": reply(
                "Stilmallen.", {"text/css": {"schema": {"type": "string"}}}, {"ETag": {"schema": {"type": "string"}}}
            ),
            "304": reply("Stilmallen är oförändrad."),
        },
        parameters=(header("If-None-Match", "`ETag` från ett tidigare svar."),),
    ),
    ("GET", "/api/auth/login"): Op(
        "Inloggning",
        "Starta inloggningen mot Eneo",
        "Skickar webbläsaren till Eneos `/module-login` och sätter kakan `"
        + STATE_COOKIE
        + "`, som binder återkomsten till den webbläsare som började.",
        success={"303": reply("Till Eneos inloggning.", headers=REDIRECT)},
    ),
    ("GET", "/api/auth/callback"): Op(
        "Inloggning",
        "Ta emot inloggningen från Eneo",
        "Byter ticketen mot en session och sätter kakan `"
        + SESSION_COOKIE
        + "` (`HttpOnly`, `SameSite=Lax`). Misslyckas något går webbläsaren till `/?auth_error=<kod>`; "
        "koderna är `invalid_state`, `exchange_unavailable`, `exchange_failed`, `exchange_invalid`, "
        "`validation_unavailable`, `validation_failed` och `validation_invalid`. "
        "Är det en annan användare än den som bad om en förnyad inloggning går den till `next?fel=annan-anvandare`.",
        success={"303": reply("Till sidan som inloggningen började på, eller till felet.", headers=REDIRECT)},
    ),
    ("POST", "/api/auth/logout"): Op(
        "Inloggning",
        "Logga ut",
        "Tar bort sessionen i backenden och kakan i webbläsaren. Kräver inte någon session: den som redan är utloggad "
        "får samma svar.",
        origin=True,
        success={"200": reply("Utloggad.", json_of({"type": "object", "properties": {"ok": {"const": True}}}))},
    ),
    ("GET", "/api/auth/status"): Op(
        "Inloggning",
        "Vem är inloggad",
        "Sidan frågar vid start och när sessionen närmar sig sitt slut. Förnyar sessionens token när den är på väg att "
        "gå ut. `Cache-Control: no-store`.",
        success={"200": reply("Inloggningsläget.", json_of({"$ref": "#/components/schemas/Status"}))},
    ),
    ("POST", "/api/eneo/flows/{flow_id}/files/"): Op(
        "Uppladdning",
        "Ladda upp en fil till ett flöde",
        "Modulen läser upp filen och skickar den vidare till Eneo som en ny förfrågan; webbläsarens egna rubriker går "
        "inte med. En fil som är hel hos modulen "
        "lämnas alltid vidare, även om webbläsaren har gått.",
        session=True,
        origin=True,
        user="required",
        body=UPLOAD_BODY,
        success=ENEO_ANSWERS,
        parameters=(UPLOAD_TIMEOUT,),
        errors=UPLOAD_ERRORS,
        too_large="max_upload_bytes",
    ),
    ("POST", "/api/eneo/flows/{flow_id}/steps/{step_id}/runtime-files/"): Op(
        "Uppladdning",
        "Ladda upp en fil till flödets ljudsteg",
        "Som uppladdningen till flödet, till ett steg.",
        session=True,
        origin=True,
        user="required",
        body=UPLOAD_BODY,
        success=ENEO_ANSWERS,
        parameters=(UPLOAD_TIMEOUT,),
        errors=UPLOAD_ERRORS,
        too_large="max_upload_bytes",
    ),
    ("GET", "/api/eneo/flows/{flow_id}/runs/{run_id}/input-files/{file_id}/audio"): Op(
        "Filer",
        "Körningens ljud",
        "Modulen ber Eneo om en tidsbegränsad URL med sina egna uppgifter och strömmar filen därifrån; URL:en är en "
        "nyckel till filen och når aldrig webbläsaren. "
        "Ingen `X-Expected-User` behövs: en `<audio src>` kan inte skicka huvuden.",
        session=True,
        success={"200": file_answer("Ljudfilen"), "206": file_answer("Det begärda intervallet")},
        parameters=(RANGE,),
        errors=STREAM_ERRORS,
    ),
    ("GET", "/api/eneo/flows/{flow_id}/runs/{run_id}/artifacts/{file_id}/content"): Op(
        "Filer",
        "En genererad fil",
        "Under det namn Eneo gav filen. En PDF med `disposition=inline` öppnas i webbläsaren och får `X-Frame-Options: "
        "SAMEORIGIN`; allt annat laddas ner.",
        session=True,
        success={"200": file_answer("Filen"), "206": file_answer("Det begärda intervallet")},
        parameters=(RANGE,),
        errors=STREAM_ERRORS,
    ),
}

RUN = "/api/eneo/flows/{flow_id}/runs/{run_id}"
STEP = RUN + "/steps/{step_id}"
CHECKPOINT = RUN + "/review-checkpoints/{checkpoint_id}"
ENEO_SUMMARIES: dict[tuple[str, str], str] = {
    ("GET", "/api/eneo/flows/"): "Lista flöden",
    ("GET", "/api/eneo/flows/{flow_id}/published/"): "Flödets publicerade version",
    ("GET", "/api/eneo/flows/{flow_id}/run-contract/"): "Flödets körningskontrakt",
    ("GET", "/api/eneo/flows/{flow_id}/graph/"): "Flödets graf för en körning (`run_id` som frågeparameter)",
    ("GET", "/api/eneo/flows/{flow_id}/runs/"): "Lista körningar",
    ("POST", "/api/eneo/flows/{flow_id}/runs/"): "Starta en körning",
    ("GET", RUN + "/"): "Hämta en körning",
    ("GET", RUN + "/status/"): "Körningens status",
    ("GET", RUN + "/steps/"): "Körningens steg",
    ("GET", STEP + "/transcript-words/"): "Transkriptets ord i ett steg",
    ("GET", RUN + "/transcript-corrections/"): "Körningens rättningar av transkriptet",
    (
        "GET",
        STEP + "/attempts/{attempt_id}/transcript-source/",
    ): "Transkriptets källsegment i ett försök (`start_segment_index` som frågeparameter)",
    ("PATCH", STEP + "/transcript-corrections/"): "Spara rättningar av transkriptet",
    ("POST", RUN + "/cancel/"): "Avbryt en körning",
    ("POST", RUN + "/retry/"): "Försök igen från det misslyckade steget",
    ("POST", STEP + "/transcript-regenerations/"): "Skapa dokumentet igen med rättningarna",
    ("GET", RUN + "/review-checkpoints/active/"): "Körningens aktiva granskningspunkt",
    ("PATCH", CHECKPOINT + "/"): "Ändra en granskningspunkt",
    ("POST", CHECKPOINT + "/approve/"): "Godkänn en granskningspunkt",
    ("POST", CHECKPOINT + "/reject/"): "Avvisa en granskningspunkt",
    ("POST", CHECKPOINT + "/resume/"): "Återuppta körningen efter en granskningspunkt",
}


def operation_id(method: str, path: str) -> str:
    return method.lower() + "_" + re.sub(r"[^0-9A-Za-z]+", "_", path).strip("_")


def path_parameter(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "in": "path",
        "required": True,
        "description": PATH_PARAMETERS[name],
        "schema": {"type": "string"},
    }


def describe_generated(parameters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The path and query parameters the generator found, with their text and without its titles.

    The session cookie it finds on a route is the security scheme's.
    """
    described = []
    for parameter in parameters:
        if parameter["in"] == "cookie":
            continue
        schema = {key: value for key, value in parameter["schema"].items() if key != "title"}
        texts = PATH_PARAMETERS if parameter["in"] == "path" else QUERY_PARAMETERS
        if parameter["name"] not in texts:
            raise SystemExit(f"export_openapi.py: no text for the {parameter['in']} parameter {parameter['name']}")
        described.append({**parameter, "schema": schema, "description": texts[parameter["name"]]})
    return described


def refusals(op: Op) -> dict[str, Any]:
    responses: dict[str, Any] = {}
    if op.session:
        responses["401"] = {"$ref": "#/components/responses/Unauthenticated"}
    if op.too_large == "max_upload_bytes":  # an upload: what the module itself checks before it forwards a byte
        responses["400"] = reply(
            "Inte exakt en fil med namnet `upload_file`, ett filnamn eller en innehållstyp med styrtecken, eller en "
            "`Content-Length` som inte är ett tal.",
            json_of(ERROR),
        )
        responses["411"] = reply("`Content-Length` saknas.", json_of(ERROR))
    if op.origin:
        responses["403"] = {"$ref": "#/components/responses/OriginRefused"}
    if op.user is not None:
        responses["409"] = {"$ref": "#/components/responses/UserChanged"}
    if op.too_large is not None:
        responses["413"] = reply(
            "Kroppen är större än modulens tak. Eneo har egna tak, som kommer tillbaka från Eneo; här står det "
            "modulens som blev passerat.",
            json_of({"$ref": "#/components/schemas/TooLarge"}),
        )
    for status in ("502", "504"):
        codes = [code for code in op.errors if (status == "504") == (code == "upstream_upload_timeout")]
        if codes:
            responses[status] = reply(
                "Modulen når inte Eneo, eller kan inte använda svaret. `error` är "
                + " eller ".join(f"`{code}`" for code in codes)
                + ".",
                json_of({"$ref": "#/components/schemas/BffError"}),
            )
    return responses


def build_operation(method: str, path: str, op: Op, parameters: list[dict[str, Any]]) -> dict[str, Any]:
    if op.origin:
        parameters = [*parameters, {"$ref": "#/components/parameters/Origin"}]
    if op.user is not None:
        name = "ExpectedUser" if op.user == "required" else "ExpectedUserOptional"
        parameters = [*parameters, {"$ref": f"#/components/parameters/{name}"}]
    parameters = [*parameters, *op.parameters]
    checked = [p["schema"] for p in parameters if p.get("in") in ("path", "query")]
    responses = {**(op.success or {}), **refusals(op)}
    if any("enum" in schema or schema.get("type") == "boolean" for schema in checked):
        responses["422"] = reply(
            "Ett värde som inte är ett av de tillåtna.", json_of({"$ref": "#/components/schemas/HTTPValidationError"})
        )
    result: dict[str, Any] = {"tags": [op.tag], "summary": op.summary, "operationId": operation_id(method, path)}
    if op.description:
        result["description"] = op.description
    if parameters:
        result["parameters"] = parameters
    if op.body:
        result["requestBody"] = op.body
    if op.session:
        result["security"] = [{"sessionCookie": []}]
    result["responses"] = dict(sorted(responses.items()))
    return result


def eneo_operation(method: str, template: str) -> dict[str, Any]:
    upstream = "{ENEO_BACKEND_URL}/api/v1/" + template.removeprefix("/api/eneo/")
    op = Op(
        "Eneo",
        ENEO_SUMMARIES[(method, template)],
        f"Skickas vidare till `{upstream}`.",
        session=True,
        origin=method != "GET",
        user="optional" if method == "GET" else "required",
        success=ENEO_ANSWERS,
        errors=PROXY_ERRORS,
        body=None
        if method == "GET"
        else {"required": False, "content": json_of({"$ref": "#/components/schemas/EneoPayload"})},
        too_large=None if method == "GET" else "max_body_bytes",
    )
    return build_operation(method, template, op, [path_parameter(name) for name in compile_path(template)[2]])


COMPONENTS: dict[str, Any] = {
    "securitySchemes": {
        "sessionCookie": {
            "type": "apiKey",
            "in": "cookie",
            "name": SESSION_COOKIE,
            "description": "Modulens session. `/api/auth/callback` sätter den efter inloggningen i Eneo; den är en "
            "opak kaka och värdet säger inget om användaren. "
            "Den följer bara med anrop från modulens egen webbplats, och det som ändrar något kräver dessutom modulens "
            "`Origin`.",
        }
    },
    "parameters": {
        "Origin": header(
            "Origin",
            "Modulens egen origin (`MODULE_PUBLIC_URL`). Webbläsaren sätter den; en annan ger 403.",
            required=True,
        ),
        "ExpectedUser": header(
            "X-Expected-User",
            "Id för den användare sidan öppnades för (`user.id` i `/api/auth/status`). Är det en annans än sessionens "
            "svarar modulen 409 `user_changed` innan kroppen läses.",
            required=True,
        ),
        "ExpectedUserOptional": header(
            "X-Expected-User",
            "Som vid ändringar, men en läsning får sakna det. Ett namn som skickas måste vara sessionens.",
        ),
    },
    "responses": {
        "Unauthenticated": reply(
            "Ingen giltig session. Sidan går till inloggningen.",
            json_of(ERROR),
            {"X-Auth-Required": {"description": "Alltid `session`.", "schema": {"type": "string"}}},
        ),
        "EneoAnswer": reply(
            "Eneos svar, oförändrat: Eneos statuskod, innehållstyp och innehåll (högst `MAX_RESPONSE_BYTES`; ett "
            "längre svar blir `502 upstream_too_large`). Modulen lägger inget till och beskriver inget av det.",
            json_of({"$ref": "#/components/schemas/EneoPayload"}),
        ),
        "OriginRefused": reply("`Origin` är inte modulens egen.", json_of(ERROR)),
        "UserChanged": reply(
            "Sidan är öppnad för en annan användare än sessionens (`detail` är `user_changed`).", json_of(ERROR)
        ),
    },
    "schemas": {
        "Error": {"type": "object", "required": ["detail"], "properties": {"detail": {"type": "string"}}},
        "BffError": {
            "type": "object",
            "required": ["error", "detail"],
            "properties": {"error": {"type": "string", "enum": BFF_ERRORS}, "detail": {"type": "string"}},
            "description": "Modulens svar när den inte kan ge Eneos.",
        },
        "TooLarge": {
            "type": "object",
            "required": ["detail"],
            "properties": {
                "detail": {"type": "string"},
                "max_body_bytes": {"type": "integer"},
                "max_upload_bytes": {"type": "integer"},
            },
            "description": "Den gräns som blev passerad står med sitt värde.",
        },
        "EneoPayload": {
            "description": "Eneos innehåll, vilken JSON det än är. Modulen beskriver det inte: se Eneos egen "
            "beskrivning."
        },
        "Branding": {
            "type": "object",
            "required": ["organization"],
            "properties": {
                "organization": {
                    "anyOf": [{"$ref": "#/components/schemas/Organization"}, {"type": "null"}],
                    "description": "Null när organisationen inte ska visas (`SHOW_ORGANIZATION=false`): bara "
                    '"Tal till text".',
                }
            },
        },
        "Status": {
            "type": "object",
            "required": ["authenticated", "user"],
            "properties": {
                "authenticated": {"type": "boolean"},
                "user": {"anyOf": [{"$ref": "#/components/schemas/ModuleUser"}, {"type": "null"}]},
                "session_ends_in": {"type": "integer", "description": "Sekunder till sessionens fasta slut."},
                "refresh_in": {
                    "type": "integer",
                    "description": "Sekunder tills sidan frågar igen, så att en session utan andra anrop (en "
                    "inspelning) förnyas.",
                },
                "max_upload_bytes": {
                    "type": "integer",
                    "description": "Vad sidan får skicka i en uppladdning (hela begäran, så en fil får lite mindre).",
                },
            },
        },
    },
}


MODEL_TEXT = {
    "Organization": 'Organisationen bredvid "Tal till text": namnet och logotypen. `logo` är `default` för den '
    "medföljande logotypen, `custom` för driftsättningens egen (hämtas från "
    "`/api/branding/logo/{variant}`) och null för bara namnet som text.",
    "LogoSize": "En logotyps proportioner: sidan ger sin `<img>` den bredden och höjden, så att sidhuvudet inte "
    "flyttar sig när filen kommer.",
    "LogoSizes": "Proportionerna för den ljusa logotypen och, om det finns en, den mörka.",
    "ModuleUser": "Användaren som är inloggad.",
}


def without_titles(node: Any) -> Any:
    if isinstance(node, dict):
        return {key: without_titles(value) for key, value in node.items() if key != "title"}
    if isinstance(node, list):
        return [without_titles(value) for value in node]
    return node


def model_schemas(*models: type[BaseModel]) -> dict[str, Any]:
    """The schemas of models of the app, and of those they hold, for components.schemas: the fields are the models'.

    Their docstrings are English notes for the code, so each schema has the text of MODEL_TEXT instead.
    """
    schemas: dict[str, Any] = {}
    for model in models:
        schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        schemas.update(schema.pop("$defs", {}))
        schemas[model.__name__] = schema
    return {
        name: {
            **without_titles({key: value for key, value in schema.items() if key != "description"}),
            "description": MODEL_TEXT[name],
        }
        for name, schema in schemas.items()
    }


def build() -> dict[str, Any]:
    """The OpenAPI document of the app, as a dict that is the same for the same code."""
    with warnings.catch_warnings():
        # A route for two methods or two paths gets one generated operation id for both; the ids below are made from
        # method and path.
        warnings.filterwarnings("ignore", message="Duplicate Operation ID")
        generated = deepcopy(main.app.openapi())
    routes = {
        (method.upper(), path): operation
        for path, operations in generated["paths"].items()
        for method, operation in operations.items()
    }
    catch_all = "/api/eneo/{path}"
    own = {key for key in routes if key[1] != catch_all}
    proxied = {(method, template) for methods, template in main.PROXY_ROUTES for method in methods}
    missing = sorted((own - set(OPERATIONS)) | (proxied - set(ENEO_SUMMARIES)))
    stale = sorted((set(OPERATIONS) - own) | (set(ENEO_SUMMARIES) - proxied))
    if missing or stale:
        raise SystemExit(f"export_openapi.py: no text for {missing}; text for nothing in the app: {stale}")

    paths: dict[str, Any] = {}
    for key, op in OPERATIONS.items():
        method, path = key
        parameters = describe_generated(routes[key].get("parameters", []))
        paths.setdefault(path, {})[method.lower()] = build_operation(method, path, op, parameters)
    for methods, template in main.PROXY_ROUTES:
        for method in sorted(methods):
            paths.setdefault(template, {})[method.lower()] = eneo_operation(method, template)

    components = deepcopy(COMPONENTS)
    components["schemas"].update(model_schemas(Organization, ModuleUser))
    components["schemas"]["HTTPValidationError"] = generated["components"]["schemas"]["HTTPValidationError"]
    components["schemas"]["ValidationError"] = generated["components"]["schemas"]["ValidationError"]
    return {
        "openapi": generated["openapi"],
        "info": {
            "title": "Tal till text: modulens backend",
            "version": "1.0.0",
            "description": (
                "Backend-for-frontend för Eneos modul Tal till text. Det är sidans egen server och inget publikt API: "
                "webbläsaren når den på modulens egen adress "
                "och den når Eneo åt personen.\n\nModulens egna rutter (`/api/auth`, `/api/branding`, uppladdningar "
                "och filströmmar) beskrivs här i sin helhet. "
                "Anropen till Eneo (`/api/eneo/...`) är bara de som tillåtelselistan räknar upp, och deras innehåll är "
                "Eneos. "
                "Live-transkriberingen går över en WebSocket, `/api/live/{flow_id}/{step_id}`, som OpenAPI inte "
                "beskriver: den står under Live-reläet i backendsidan."
            ),
        },
        "servers": [
            {"url": PLACEHOLDERS["MODULE_PUBLIC_URL"], "description": "Modulens egen adress (`MODULE_PUBLIC_URL`)."}
        ],
        "tags": [
            {
                "name": name,
                "description": text,
                **(
                    {"externalDocs": {"description": "Eneos beskrivning", "url": ENEO_CONTRACT_URL}}
                    if name == "Eneo"
                    else {}
                ),
            }
            for name, text in TAGS
        ],
        "paths": paths,
        "components": components,
    }


def render() -> str:
    return json.dumps(build(), ensure_ascii=False, indent=2) + "\n"


def export(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render(), encoding="utf-8")


if __name__ == "__main__":
    try:
        export(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH)
    finally:
        asyncio.run(main.http_client.aclose())
