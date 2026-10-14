# Retoque

Editor de imagens que roda inteiro no navegador, sem instalação e sem servidor.
As imagens nunca saem do seu computador.

## Recursos

**Camadas**
- Camadas ilimitadas com visibilidade, opacidade e 16 modos de mesclagem (Multiplicação, Tela, Sobrepor, Luz suave…)
- Arrastar para reordenar, duplicar, mesclar com a de baixo, achatar, renomear com clique duplo
- Camadas de texto continuam editáveis até serem convertidas em pixels

**Ferramentas**
| Ferramenta | Tecla | O que faz |
| --- | --- | --- |
| Mover | V | Move a camada ativa; Ctrl+clique escolhe a camada sob o cursor; setas movem 1 px |
| Seleção retangular | M | Limita pintura, ajustes, filtros, cópia e corte à área selecionada |
| Cortar | C | Moldura com alças, grade dos terços e proporções fixas (1:1, 4:5, 3:2, 16:9, 9:16…) |
| Pincel | B | Tamanho, dureza, opacidade e pressão de caneta; Shift+clique traça retas |
| Borracha | E | Apaga para transparência, com as mesmas opções do pincel |
| Balde de tinta | G | Preenchimento com tolerância, contíguo ou global |
| Gradiente | Shift+G | Linear ou radial, entre duas cores ou para transparente |
| Formas | U | Retângulo, elipse, linha e seta, preenchidas ou com contorno |
| Texto | T | Fontes, tamanho, negrito, itálico, alinhamento e várias linhas |
| Conta-gotas | I | Amostra pontual ou média de 3×3 a 11×11 |
| Mão e Zoom | H, Z | Navegação; Espaço ativa a mão a qualquer momento |

**Ajustes com prévia ao vivo**: exposição, contraste, brilho, realces, sombras, temperatura,
tonalidade, vibração, saturação e matiz.

**Filtros**: desfoque gaussiano, máscara de nitidez, ruído, pixelizar, vinheta, posterizar,
limiar, preto e branco, sépia, inverter, detectar bordas, contraste e tom automáticos.

**Imagem**: tamanho da imagem (bicúbico ou pixel art), tamanho da tela com âncora,
girar 90°/180°, espelhar, cortar para a seleção.

**Arquivos**: abre PNG, JPEG, WebP, GIF, BMP, SVG e DNG do Lightroom (pelo menu, arrastando ou colando com Ctrl+V);
exporta PNG, JPEG e WebP com qualidade, escala e tamanho estimado; salva e reabre projetos
`.retoque.json` com todas as camadas.

**Também**: histórico com até 60 passos (clique para voltar a qualquer um), histograma RGB,
tema claro e escuro, gestos de pinça no celular e mais de 40 atalhos de teclado (`?` mostra a lista).

## Edição automática em lote

Aplica em dezenas de fotos de uma vez o estilo de quem edita no Lightroom
(menu **Arquivo › Edição automática em lote** ou o botão **Edição em lote**).

1. **Ensine o estilo.** Adicione fotos já editadas no Lightroom e exportadas em **DNG**.
   Cada DNG exportado pelo Lightroom traz a foto original, a versão editada e as
   configurações usadas. O Retoque compara original e edição e aprende o estilo: curvas de
   tom por canal mais uma tabela 3D de cores, que capturam exposição, contraste, curvas,
   HSL, tonalização e saturação. Nitidez e vinheta são lidas direto das configurações do
   Lightroom. Quanto mais fotos editadas, melhor o estilo; dá para marcar só algumas
   (por exemplo, só os ensaios externos) e salvar cada estilo em um arquivo `.json`.
2. **Adicione as fotos** (JPEG, PNG, WebP ou DNG). Cada uma ganha uma exposição automática
   que aproxima o brilho do resultado ao das fotos de referência. Os botões − e + corrigem
   uma foto específica; segurar o clique sobre a foto mostra o original.
3. **Exporte.** Sai um `.zip` com os JPEGs em tamanho original (ou reduzido), já girados
   corretamente e com data, câmera e lente preservadas, para manter a ordem na galeria.

Qualquer foto pode ser aberta no editor para retoques finais: ela entra com duas camadas,
a editada e a original (oculta). O estilo aprendido também fica em **Filtros › Aplicar
estilo aprendido** para uso numa foto só.

Tudo roda no aparelho: nenhuma foto é enviada para servidor algum. O estilo fica guardado
neste navegador até você clicar em *Esquecer estilo salvo*.

**O que o estilo não reproduz:** retoques locais (máscaras, pincel de ajuste, remoção de
manchas), cortes e endireitamento, redução de ruído, e o efeito exato de Claridade,
Textura e Desembaçar. Fotos tiradas em RAW (CR3, CR2, NEF…) ainda não são lidas; o
aprendizado precisa de DNGs cujo original veio de um JPEG da câmera, como os exportados
pelo Lightroom Mobile a partir de fotos JPEG.

## Como usar

Abra `index.html` direto no navegador (Chrome, Edge, Firefox ou Safari recentes). Funciona
offline; só as fontes da interface vêm da internet.

Ou rode um servidor local:

```bash
cd image-editor
npm start            # http://localhost:8080
```

### Publicar no GitHub Pages

Em **Settings → Pages**, escolha *Deploy from a branch*, a branch `main` e a pasta `/ (root)`.
O editor fica em `https://<seu-usuário>.github.io/<repositório>/image-editor/`.

## Desenvolvimento

```bash
npm test             # testes de imagem, histórico, estilo, DNG/EXIF e ZIP (node:test, sem dependências)
npm run build        # gera dist/retoque.html, um arquivo único com tudo embutido
```

Não há dependências nem etapa de compilação: são scripts clássicos carregados em ordem.

```
image-editor/
├── index.html
├── css/editor.css       tokens de cor (claro/escuro) e layout
├── js/imageops.js       operações de pixel puras (ajustes, filtros, balde, histograma)
├── js/history.js        desfazer/refazer com orçamento de memória
├── js/document.js       documento, camadas, texto e utilitários de canvas
├── js/view.js           zoom, deslocamento e desenho da área de trabalho
├── js/tools.js          ferramentas
├── js/ui.js             menus, painéis, diálogos e avisos
├── js/app.js            comandos, atalhos, arquivos e inicialização
├── js/sample.js         imagem de exemplo gerada por código
├── js/style.js          aprendizado e aplicação do estilo (curvas + tabela 3D de cores)
├── js/metadata.js       leitura de DNG/TIFF, configurações do Lightroom (XMP) e EXIF
├── js/decode.js         leitura de fotos para canvas, com orientação EXIF
├── js/zip.js            geração de ZIP sem dependências
├── js/batch.js          tela de edição automática em lote
├── tests/               testes em Node
└── scripts/build-single.js
```

### Decisões de arquitetura

- **Canvases imutáveis.** Nenhuma edição altera o canvas de uma camada no lugar: cria-se um
  canvas novo e troca-se a referência. Assim cada passo do histórico guarda só referências,
  e passos que não mexem em pixels (mover, opacidade, seleção) quase não ocupam memória.
  O histórico descarta os passos mais antigos quando o total passa de 768 MB.
- **Ajustes por tabela.** Balanço de branco e exposição são aplicados em luz linear;
  brilho, contraste, realces e sombras viram uma tabela de 256 valores por canal, e só
  matiz, saturação e vibração são calculados pixel a pixel. Isso mantém a prévia fluida
  em fotos de 12 MP.
- **Estilo aprendido.** As curvas por canal são ajustadas com regressão isotônica (sempre
  crescentes). A correção residual de cada cor fica numa grade 25×25×25, resolvida com
  suavização entre vizinhos e um leve decaimento para zero: cores que não aparecem nas
  referências recebem só as curvas, sem mudanças inventadas. As bordas da foto pesam
  menos no aprendizado para a vinheta não contaminar o estilo.
- **Desfoque em tempo linear.** O desfoque gaussiano usa três passadas de média móvel
  com alfa pré-multiplicado, então o custo não depende do raio e as bordas transparentes
  não escurecem.

## Limitações conhecidas

- A seleção é só retangular (ainda não há laço nem varinha mágica).
- Ajustes e filtros são destrutivos (podem ser desfeitos pelo histórico, mas não há camadas de ajuste).
- Não abre nem salva arquivos PSD.
- O tamanho máximo do documento é 50 megapixels (16 MP no iPhone e iPad, por limite do Safari).
