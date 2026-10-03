# Le mode du convoyeur (DP5 = 2), lu dans les arguments de SON declencheur :
# `REEL` si l'un d'eux est exactement $reel, comme `args.includes` de
# src/convoyeur/main.ts ; `DRY_RUN` sinon, l'oubli ne met jamais en reel.
# `non lu` si le declencheur manque ou si ses arguments n'ont pas la forme du
# SDK (`cron_config.args`, un tableau, null quand il est vide) : une forme
# inattendue ne passe pas pour un DRY_RUN.
# Entree : la reponse de `scw jobs trigger list … -o json`. Appele par
# controles.sh et relecture.sh avec --arg nom et --arg reel.
[ (if type == "array" then .[] else .triggers[] end) | select(.name == $nom) ]
| if length != 1 or (.[0].cron_config | type) != "object" or (.[0].cron_config | has("args") | not) then "non lu"
  else .[0].cron_config.args
  | if . == null then "DRY_RUN"
    elif type != "array" then "non lu"
    elif any(.[]; . == $reel) then "REEL"
    else "DRY_RUN" end
  end
