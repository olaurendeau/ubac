# Smoke — fichier témoin Orca Cursor

## Besoin

Valider le cycle Orca avec Cursor : une mini-spec locale et un fichier
témoin dont le contenu est vérifiable octet par octet.

## Périmètre inclus

- `smoke/spec.md` : cette mini-spec
- `smoke/value.txt` : fichier témoin

## Périmètre exclu

- Toute source métier Ubac
- Installation Node / npm
- Fusion de la PR

## Critère d'acceptation

`smoke/value.txt` contient exactement les octets `OK` suivis d'un saut de ligne
(`0x4f 0x4b 0x0a`).

## Vérification

```sh
python3 -c "from pathlib import Path; b=Path('smoke/value.txt').read_bytes(); assert b==b'OK\n', repr(b); print(b, b.hex(), 'VERIFY_OK')"
```
