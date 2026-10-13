"""Provision the single local administrator interactively; passwords never use CLI arguments."""

import argparse
import getpass
import json
from pathlib import Path
import sys
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import httpx
from scripts.run_postgres_pilot import checked_stack,admin_sql
from scripts import supabase_local as local


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-disposable",action="store_true",required=True)
    parser.parse_args()
    cli,docker = checked_stack()
    # No adoption of an existing account or administrator.
    if admin_sql(docker,"select count(*) from auth.users;").strip() != "0":
        raise RuntimeError("Existing Auth accounts; inspect them before provisioning.")
    if admin_sql(docker,"select admin_user_id is null and not admin_habilitado from simpress.configuracao where id=1;").strip() != "t":
        raise RuntimeError("Administrator already configured.")
    email = input("E-mail da conta administradora local: ").strip()
    password = getpass.getpass("Senha (mínimo 12 caracteres): ")
    confirmation = getpass.getpass("Repita a senha: ")
    if not 3 <= len(email) <= 254 or "@" not in email or len(password) < 12 or password != confirmation:
        raise RuntimeError("Invalid email or password confirmation.")
    status = json.loads(local.run([*cli,"status","--output","json","--agent","no"]))
    with httpx.Client(base_url="http://127.0.0.1:54321/auth/v1/",trust_env=False,follow_redirects=False,
        timeout=10,headers={"apikey":status["SERVICE_ROLE_KEY"],"Authorization":"Bearer "+status["SERVICE_ROLE_KEY"]}) as client:
        response = client.post("admin/users",json={"email":email,"password":password,"email_confirm":True})
        if response.status_code not in (200,201):
            raise RuntimeError("Auth provisioning failed; response suppressed.")
        uid = str(UUID(response.json()["id"]))
        try:
            # Serialize binding. A concurrent provision cannot overwrite it.
            admin_sql(docker,"""begin; lock simpress.configuracao in exclusive mode;
                do $$ begin
                if exists(select 1 from simpress.configuracao where admin_user_id is not null or admin_habilitado)
                then raise exception 'Administrator already configured'; end if;
                update simpress.configuracao set admin_user_id='"""+uid+"""',admin_habilitado=true where id=1;
                end $$; commit;""")
        except Exception:
            client.delete("admin/users/"+uid)
            raise
    print("Conta local vinculada. Inicie o piloto com --auth; nenhum segredo foi salvo no projeto.")


if __name__ == "__main__":
    try:
        main()
    except (Exception,KeyboardInterrupt) as error:
        print(f"Provisionamento não concluído ({type(error).__name__}); detalhes e credenciais suprimidos.",file=sys.stderr)
        sys.exit(1)
