"""Read-only routes that describe local application configuration and readiness."""

from fastapi import APIRouter


def create_system_router(ctx):
    router = APIRouter()

    @router.get("/api/prontidao")
    def get_readiness_status():
        """Expose local file and feature availability for the status panel."""
        return ctx.get_startup_readiness()

    @router.get("/api/config/transferencia")
    def get_transfer_form_defaults():
        """Return editable origin contact defaults configured for this installation."""
        return {
            "retirada_contato": ctx.TRANSFER_ORIGIN_CONTACT,
            "retirada_email": ctx.TRANSFER_ORIGIN_EMAIL,
            "retirada_telefone": ctx.TRANSFER_ORIGIN_PHONE,
        }

    return router, {
        "get_readiness_status": get_readiness_status,
        "get_transfer_form_defaults": get_transfer_form_defaults,
    }
