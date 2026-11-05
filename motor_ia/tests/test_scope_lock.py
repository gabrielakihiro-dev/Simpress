import pytest

from motor.scope_lock import ForaDoEscopoError, resolver_dentro_do_escopo


@pytest.fixture
def base_dir(tmp_path):
    base = tmp_path / "workspace"
    base.mkdir()
    return base


def test_caminho_dentro_do_escopo_resolve(base_dir):
    alvo = resolver_dentro_do_escopo(base_dir, "sub/arquivo.py")
    assert alvo == (base_dir / "sub" / "arquivo.py").resolve()


def test_bloqueia_subida_de_diretorio(base_dir):
    with pytest.raises(ForaDoEscopoError):
        resolver_dentro_do_escopo(base_dir, "../fora.py")


def test_bloqueia_pasta_irma_com_prefixo_igual(base_dir):
    # dossiê #7: `startswith("./workspace")` aceitava `./workspace2` por engano.
    irma = base_dir.parent / "workspace2"
    irma.mkdir()
    with pytest.raises(ForaDoEscopoError):
        resolver_dentro_do_escopo(base_dir, str(irma / "x.py"))


def test_bloqueia_caminho_absoluto_fora(base_dir, tmp_path):
    fora = tmp_path / "fora_de_tudo.py"
    with pytest.raises(ForaDoEscopoError):
        resolver_dentro_do_escopo(base_dir, str(fora))
