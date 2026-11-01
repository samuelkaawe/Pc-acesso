# RemotePC

Controle o PC pelo celular: tela + mouse + teclado, gamepad/volante virtual, atalhos, arquivos e celular como webcam.

* `server/` – programa do PC (Python → `RemotePC-Server.exe`)
* `android/` – app do celular (Kotlin → `app-debug.apk`)
* `.github/workflows/build.yml` – compila os dois no GitHub

## 1. Gerar o APK e o EXE no GitHub
1. Crie um repositório no GitHub (pode ser privado) e envie **todo o conteúdo** desta pasta (inclusive a pasta oculta `.github`).
   Se a `.github` não subir pelo navegador: *Add file → Create new file*, nome `.github/workflows/build.yml`, e cole o conteúdo de `workflow-build.yml.txt`.
2. Aba **Actions** → *Build RemotePC* → **Run workflow** (ou faça um commit).
3. Quando terminar (verde), abra a execução e baixe os *Artifacts*: **RemotePC-APK** e **RemotePC-Server-EXE**.
4. Se algum job ficar vermelho, copie o erro do log e me envie.

## 2. No PC (Windows)
1. Execute `RemotePC-Server.exe`. Ele mostra o **PIN** e o **IP:porta**. Permita no Firewall (rede privada).
2. Para **jogar com controle virtual**: instale o driver **ViGEmBus** (github.com/nefarius/ViGEmBus, em *Releases*).
3. Para **webcam**: instale o **OBS Studio**, abra uma vez, clique em *Iniciar câmera virtual* e depois pare. Nos apps (Zoom, Discord…) escolha *OBS Virtual Camera*.
4. Para controlar janelas de programas "como administrador", rode o servidor como administrador.

## 3. No celular
1. Instale o APK (permita "fontes desconhecidas"). Celular e PC na **mesma rede Wi-Fi**.
2. Digite o IP:porta mostrado no PC → digite o PIN.
3. Abas: **Tela** (touchpad/toque direto, teclado), **Jogar** (controle e volante com tela do PC ao fundo), **Atalhos**, **Arquivos**, **Webcam**, **Mais**.

### Gestos da aba Tela
Toque = clique · dois dedos tocando = botão direito · dois dedos arrastando = rolagem · segurar e arrastar = arrastar/selecionar.

### Jogar
* ✏️ edita o layout (arraste, tamanho, ocultar) · 🎡/🎮 alterna volante/controle · ⚙ configurações
* Volante: graus configuráveis de 90° a 1800° (total), volta ao centro ao soltar (opcional), pedais analógicos.
* Botões de volume do celular viram botões programáveis (⚙ para escolher qual botão do controle).

## Acesso fora de casa
Não abra portas no roteador. Instale o **Tailscale** no PC e no celular e use o IP `100.x.x.x` do PC no app.

## Limites desta versão
* Sem áudio do PC no celular e sem microfone do celular para o PC.
* Tela via JPEG (latência de dezenas de ms; não é cloud gaming profissional).
* Jogos com anti-cheat podem bloquear o controle virtual.
* A tela de UAC/login do Windows não aparece no stream.
* O PIN protege o acesso, mas o tráfego não é criptografado: use em rede confiável ou via Tailscale.
