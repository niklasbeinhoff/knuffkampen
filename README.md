# Knuffkampen

Ett tillfälligt partyspel i webbläsaren. Alla kör en liten knuffbil på en isarena
ovanför molnen och försöker knuffa ut varandra. Arenan tappar sin yttersta ring med
jämna mellanrum, och den som står sist kvar vinner rundan. Efter sista rundan visas
en löpsedel med vinnaren.

## Starta

```bash
cd knuffkampen
npm install   # bara första gången
npm start
```

Terminalen skriver ut **spelarlänken**, länken för att **spela som värd**, **värdlänken**
för en storbildsskärm och **rumskoden**. Koden och värdnyckeln slumpas om varje gång
servern startar, om du inte sätter `KK_CODE` och `KK_HOST_KEY`.

## Spela

- **Värden spelar själv:** öppna länken "Spela som värd" (`/?k=KOD&host=NYCKEL`), skriv
  ett namn och hoppa in som alla andra. Värdkontrollerna dyker upp i din egen vy: välj
  spel, botar och rundor (hål i golf) och starta. Under matchen finns bara en liten
  "Till lobbyn" uppe till vänster, som frågar en gång till innan den avbryter. Efter
  matchen kommer "Ny match" och "Till lobbyn". Krysset vid en spelare i ställningen
  kastar ut den. Kortet går att fälla ihop med "Dölj". Värdnyckeln försvinner ur
  adressfältet direkt, och kvar står bara spelarlänken.
- **Storbildsskärm (valfritt):** värdlänken `/?host=NYCKEL` ger en TV-vy som inte är en
  spelare. Den går att dela i mötet om du vill ha en översiktsbild.
- **Spelarna** öppnar spelarlänken, skriver ett smeknamn och hoppar in. Koden är redan
  ifylld om de använder länken.
- **Styrning:** WASD eller piltangenter. Mellanslag knuffar (ett kort ryck framåt som
  slår hårdare, med ett par sekunders laddtid). På mobil finns en styrspak och en knapp.
- I lobbyn kan alla köra runt fritt medan folk ansluter.

Värdpanelen har antal botar (0–12), antal rundor (1–7), start, tillbaka till lobbyn
och ett kryss vid varje spelare för att ta bort någon. Samma kontroller finns i
TV-vyn och hos den som spelar som värd.

## Tre spel: Knuffkampen, Molngolf och Klossgolf

Överst i värdpanelen i lobbyn väljer värden spel. Alla behåller samma länk och samma
namn när spelet byts.

**Molngolf** är minigolf på flytande öar. Alla spelar samma hål samtidigt med var sin
boll, och bollarna krockar inte med varandra.

- **Slå:** dra bakåt var som helst på bilden med musen, styrplattan eller fingret och
  släpp, som en slangbella. Längre drag ger hårdare slag. Esc avbryter.
- **Hål:** fem hål (Raksträckan, Hundbenet, Väderkvarnen, Flipperspelet, Bron) plus en
  övningsgreen i lobbyn. Varje hål har 50 sekunder och högst 8 slag.
- **Poäng:** minst antal slag vinner. En boll som lämnar banan läggs tillbaka och kostar
  ett slag.

`node tools/golf-check.js` kontrollerar att varje hål går att klara inom sitt par.

**Klossgolf** är klassisk golf med klossgubbar. Du står bakom din egen figur på ett
riktigt golfhål med tee, fairway, ruff, bunkrar, vatten och green. Bollen flyger, och
efter slaget springer figuren fram till bollen. Alla spelar samma hål samtidigt.

- **Sikta:** A/D eller piltangenterna, eller dra i sidled på bilden. En caddie väljer
  riktning och klubba varje gång bollen stannar.
- **Slå:** håll in mellanslag (eller slagknappen på skärmen) så stiger mätaren. Släpp
  när ringen på banan ligger där du vill ha bollen. Flaggan på mätaren visar hur
  mycket kraft som räcker fram till caddiens mål.
- **Klubba:** W/S eller pil upp/ner, eller knapparna på skärmen. Driver (cirka 100 m),
  järn (75 m), wedge (35 m) och putter.
- **Vind:** pilen uppe till vänster visar vindens riktning sett från där du siktar.
  Caddien räknar inte med vinden, det får du göra själv.
- **Hål:** Björkallén (par 4), Udden (par 3 över vatten), Sjösvängen (par 4),
  Långa gärdet (par 5) och Sandlådan (par 3), plus en övningsbana i lobbyn.
- **Poäng:** minst antal slag vinner. Vatten och utanför banan kostar ett slag, och
  bollen läggs tillbaka där du slog. Varje hål har en klocka och högst par + 4 slag.

`node tools/kloss-check.js` kontrollerar hålen och låter bottar spela dem.

## På GitHub Pages (ingen server)

Spelet ligger på **https://niklasbeinhoff.github.io/knuffkampen/** och behöver ingen
server och inget konto någonstans. Rummet körs i **värdens egen flik**, och de andra
kopplar upp sig direkt mot den med WebRTC. Den fria tjänsten PeerJS används bara för att
webbläsarna ska hitta varandra. Sidan är **bara Heta paketet**: startsidan, fliken och
bakgrunden visar det spelet, och värden har ingen spelväljare. Det finns ingen TV-vy.

- **Du (värd):** öppna `https://niklasbeinhoff.github.io/knuffkampen/?k=KOD&host` och
  skriv ditt namn. Rummet öppnas med den koden, och värdkontrollerna (botar, start, ny
  match, kasta ut) dyker upp i din vy. `&host` försvinner direkt ur adressfältet.
  - Låt fliken vara öppen och framme under hela spelet, för spelet körs där.
  - Om du laddar om fliken startar rummet om tomt. Alla kommer tillbaka av sig själva,
    men poängen nollställs.
- **Kollegorna:** `https://niklasbeinhoff.github.io/knuffkampen/?k=KOD`, skriv namn,
  klart. Koden fungerar som lösenord: utan den hittar man inte rummet. Du kan också
  skicka adressen utan `?k=KOD` och ge koden separat.
- **Koden:** 1–16 tecken, A–Z och siffror. Hitta på en egen, till exempel `PAKET2011`.

Begränsningar att känna till:
- Varje spelare kopplar upp sig direkt mot din dator. Vissa företagsnät stoppar sådana
  uppkopplingar. PeerJS har då en fri reläserver som reserv, men den är inte garanterad.
  Prova med ett par kollegor innan demon, gärna någon på mobilnätet.
- Din dator skickar spelet till alla, ungefär 12 kB/s per spelare. Det är inga problem
  på vanligt bredband.

Uppdatera sidan efter ändringar i koden:

```bash
npm run pages:check                      # rummets logik, utan webbläsare
node tools/build-pages.js /tmp/kk-pages  # bygg statiska filer
cd /tmp/kk-pages && git init -q -b gh-pages && git add -A && git commit -qm "Pages" \
  && git push -f git@github.com:niklasbeinhoff/knuffkampen.git gh-pages
```

GitHub Pages visar grenen `gh-pages`. `?p2p` i adressen tvingar fram Pages-läget lokalt.

## Över internet med egen server (Railway eller Render)

Lokalt lyssnar servern bara på den egna datorn (`127.0.0.1:3000`). För att kollegor ska
nå spelet körs samma kod hos en molntjänst som hämtar den från ett GitHub-repo. Servern
skickar själv ut klienten, så det behövs bara en tjänst. Den känner av Railway och
Render och lyssnar då på `0.0.0.0` och den `PORT` tjänsten anger. Den läser också
spelarnas riktiga adress ur proxyns huvuden, så spärren mot för många felförsök gäller
per spelare och inte för alla på en gång. Ändra aldrig i `/ws`, för klienten väljer
själv `wss://` när sidan går över https.

**Rekommenderat: Railway (provperiod).** Kontrollerat 2026-11-19 i Railways egen
dokumentation:

- Provperioden ger 5 dollar i kredit i 30 dagar och kräver inget kort om
  GitHub-kontot godkänns automatiskt. Den här servern drar ungefär 6 % av en kärna med
  10 spelare, så en kväll och en demo kostar några ören av krediten.
- Tjänsten sover inte under provperioden, så det blir ingen kallstart.
- Region: välj EU West (Amsterdam).
- WebSockets får vara öppna hur länge som helst.
- Begränsningar: provperioden tar slut efter 30 dagar eller när krediten är slut. Om
  GitHub-kontot inte godkänns blir det en "Limited Trial" med begränsat nätverk. Testa
  därför samma dag som du sätter upp den.

**Reserv: Render (gratisplan).** Kontrollerat 2026-11-19:

- Gratis utan tidsgräns, 750 timmar i månaden, och Frankfurt finns som region.
- Tjänsten somnar efter 15 minuter utan trafik och tar ungefär en minut att vakna.
  Öppna länken ett par minuter innan demon.
- Gratisinstansen uppges ha 0,1 CPU, och det är troligen för lite för den här servern.
  Spelet kan bli ryckigt med många spelare, så prova med några kollegor innan demon.
- Utgående trafik är begränsad till 5 GB i månaden. En halvtimme med 10 spelare är
  ungefär 0,2–0,3 GB.

### Sätta upp det (görs av dig, med ditt eget konto)

1. Lägg mappen i ett GitHub-repo. `.gitignore` håller `node_modules` utanför. Inget i
   koden är hemligt, för koden och nyckeln sätts som variabler hos tjänsten.
2. Hitta på en rumskod och en värdnyckel:
   - Koden ska vara 6 tecken, A–Z och siffror, till exempel `KNUFF7`. Den är lätt att
     skriva men svår att gissa.
   - Värdnyckeln ska vara lång och slumpad, till exempel utskriften från
     `node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"`.
3. **Railway:**
   1. Välj New Project → Deploy from GitHub repo och välj repot.
   2. Under Variables lägger du till `KK_CODE` och `KK_HOST_KEY`.
   3. Under Settings → Networking väljer du Generate Domain, och under Settings →
      Region väljer du EU West. Om Railway frågar efter port tar du porten som står
      i loggen efter `0.0.0.0:`.
   4. Railway hittar `package.json` och kör `npm start` av sig själv.
4. **Render (reserv):**
   1. Välj New → Blueprint och välj repot. `render.yaml` ger gratisplan, Frankfurt och
      hälsokoll på `/health`.
   2. Render frågar efter `KK_CODE` och `KK_HOST_KEY` när blueprinten skapas.
5. Öppna loggen hos tjänsten. Där står de färdiga länkarna med den publika adressen.
6. Kontrollera att `https://<adress>/health` svarar `ok`. Öppna sedan spelarlänken i
   två flikar och spela en runda.

### Vad du skickar till kollegorna

En länk och en kod, inget mer:

> Spela med på https://<adress>/?k=KNUFF7 – skriv ditt namn och tryck på knappen.
> Koden är KNUFF7 om den inte redan står där.

Själv öppnar du `https://<adress>/?k=KNUFF7&host=<din nyckel>`, skriver ditt namn och
startar spelen därifrån. Skicka aldrig den länken vidare. Nyckeln försvinner ur ditt
adressfält, så det som syns där går bra att dela.

Lokalt fungerar också en tunnel, till exempel `cloudflared tunnel --url
http://localhost:3000`, men då är det din dator som syns utåt.

## Testa servern

```bash
npm run smoke
```

Startar servern på en ledig port, spelar snabbspolade matcher med botar i alla fyra
spelen och kontrollerar drygt 450 saker: kod, värdnyckel, att spela som värd, faser,
poäng, spelbyte, återanslutning, skräpdata och hälsokollen.

## Inställningar

Miljövariabler för `npm start`:

- `PORT` (3000) och `HOST` (127.0.0.1, eller 0.0.0.0 hos Railway och Render).
- `KK_CODE`: egen rumskod, 1–16 tecken A–Z och 0–9. Annars slumpas fyra bokstäver.
- `KK_HOST_KEY`: egen värdnyckel.
- `KK_PUBLIC_URL`: den publika adressen till länkarna i loggen. Railway och Render ger
  den automatiskt.
- `KK_TRUST_PROXY`: `1` läser spelarens adress ur proxyns huvuden. Det är på av sig
  självt hos Railway och Render, och `0` stänger av det.

`GET /health` svarar `ok` för tjänstens hälsokoll.

## Filer

- `server/` spelservern: regler, bottar, anslutningar
- `shared/` fysik och protokoll som server och klient delar
- `public/` klienten: 3D-scen, HUD, ljud och navet som kopplar ihop dem
- `public/dev/` testsidor för utveckling (`npm run dev:static`, port 3100)
- `CONTRACT.md` gränssnitten mellan delarna
