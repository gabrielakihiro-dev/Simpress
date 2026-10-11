"""Interpret validated official source rows without opening operational files."""

from collections import Counter
from datetime import date, datetime
from typing import Any

from persistence.config import PersistenceError


def json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: json_value(v) for k,v in value.items()}
    if isinstance(value, (tuple, list)):
        return [json_value(v) for v in value]
    return value


def equipment_rows(table, domain):
    result = []
    for record in table["records"]:
        def value(*keys, default=""):
            found = domain._record_value(record, *keys)
            return str(found).strip() if found is not None and str(found).strip() else default
        serial = value(*domain.DETAILS_SERIAL_HEADER_ALIASES)
        if not serial:
            continue
        contract = domain.normalize_contract_value(value("CodigoContrato", default=str(domain.SUPPORTED_CONTRACT)))
        if contract != str(domain.SUPPORTED_CONTRACT):
            raise PersistenceError(409, "A base contém contrato não suportado; nenhuma importação foi confirmada.")
        address, city, state = value("Endereco", "Endereço"), value("Cidade"), value("UF", default="PR")
        cep = domain.format_cep(value("CEP"))
        cnpj = value(*domain.DETAILS_INSTALLATION_CNPJ_HEADER_ALIASES)
        if (any(t in address.lower() for t in ("caeté", "caete", "sede")) or "sede" in city.lower()) and any(t in city.lower() for t in ("curitiba", "sede")):
            address, city, state, cep = "R Caeté, 150 - SEDE - Prado Velho", "Curitiba", "PR", "80220-300"
        pickup = f"{address} - {city}/{state} - CEP {cep}" if address else f"{city}/{state}"
        result.append({"source_row": record["__excel_row_number__"], "serie_bruta": serial,
            "chave_api": serial.upper(), "serie_normalizada": domain.normalize_reference_value(serial),
            "modelo": value("Modelo"), "tipo": value(*domain.DETAILS_TYPE_HEADER_ALIASES),
            "apelido_base": value(*domain.DETAILS_ALIAS_HEADER_ALIASES), "id_cliente": value("IdCliente", "Id Cliente"),
            "contrato": contract, "razao_social": value("RazaoSocial", default=domain.SUPPORTED_CONTRACT_LEGAL_NAME),
            "endereco_instalacao": address, "retirada_cnpj": cnpj, "retirada_endereco": pickup,
            "retirada_cidade": city, "retirada_uf": state, "retirada_cep": cep})
    if not result:
        raise PersistenceError(409, "A base não contém equipamentos com número de série.")
    return result


def derived_units(rows, domain):
    units: dict[tuple[str,str,str],dict[str,Any]] = {}
    sede = {r["retirada_cnpj"] for r in rows if r["endereco_instalacao"] == "R Caeté, 150 - SEDE - Prado Velho" and r["retirada_cnpj"]}
    for r in rows:
        city, address, cnpj = r["retirada_cidade"], r["endereco_instalacao"], r["retirada_cnpj"]
        if city or address:
            units.setdefault((city,address,cnpj), {"cidade": city, "endereco": address,
                "uf": r["retirada_uf"], "cep": r["retirada_cep"], "cnpj": cnpj})
    result = [{"cidade": "Curitiba", "endereco": "R Caeté, 150 - SEDE - Prado Velho",
               "uf": "PR", "cep": "80220-300", "cnpj": next(iter(sede)) if len(sede) == 1 else ""}]
    foz = False
    for u in units.values():
        city, address = u["cidade"].lower(), u["endereco"].lower()
        if ("curitiba" in city or ("cascavel" in city and "plantar" not in address)
                or ("maring" in city and not any(t in address for t in ("terreo", "térreo")))
                or ("tel" in city and "borba" in city and "sala 1" not in address)
                or ("toledo" in city and u["endereco"].isupper())):
            continue
        if "foz do igua" in city:
            if foz:
                continue
            foz = True
        result.append(u)
    for u in result:
        u["_source_key"] = domain._stable_unit_source_key(u)
    return result


def source_rows(staged, domain):
    for role in ("detalhes", "endpoint"):
        table = staged[role]["table"]
        counts = Counter(domain.normalize_reference_value(domain._upload_serial_value(r, role)) for r in table["records"])
        for record in table["records"]:
            serial = domain._upload_serial_value(record, role)
            normalized = domain.normalize_reference_value(serial)
            yield {"papel": role, "aba": table["sheet"], "numero_linha": record["__excel_row_number__"],
                "celulas": [{"coluna":k,"valor":json_value(v),"tipo":type(v).__name__} for k,v in record.items() if k != "__excel_row_number__"],
                "serie_bruta": str(serial) if serial is not None else None, "serie_normalizada": normalized,
                "dados_interpretados": json_value(record), "estado_validacao": "descartada" if not normalized else "duplicada" if counts[normalized] > 1 else "valida"}
