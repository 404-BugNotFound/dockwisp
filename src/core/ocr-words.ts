/**
 * Repair the two spacing errors OCR makes most often on English text:
 * a word split by a stray space ("Furtherm ore", "com plex") and words run
 * together ("journey ofwords"). Only plain ASCII-letter tokens are touched,
 * and only when a small built-in list of common English words confirms the
 * result, so names, codes and mixed tokens pass through unchanged.
 */

// Common English words, lowercase. Kept as space-separated chunks so the
// list stays readable; it only needs to cover everyday prose.
const WORD_CHUNKS: string[] = [
  "a about above across act action actually add after again against age ago agree ahead air all allow almost alone along already also although always am among amount an and animal another answer any anyone anything appear apply approach are area argue arm around arrive art article as ask at attack attention author available avoid away baby back bad bag ball bank bar base be beat beautiful because become bed before begin behavior behind believe benefit best better between beyond big bill bit black blood blue board body book born both box boy break bring brother budget build building business but buy by call camera campaign can cancer candidate capital car card care career carry case catch cause cell center central century certain certainly chair challenge chance change character charge check child choice choose church citizen city civil claim class clear clearly close coach cold collection college color come commercial common community company compare computer concern condition conference consider consumer contain continue control cost could country couple course court cover create crime cultural culture cup current customer cut dark data daughter day dead deal death debate decade decide decision deep defense degree democratic describe design despite detail determine develop development die difference different difficult dinner direction director discover discuss discussion disease do doctor dog door down draw dream drive drop drug during each early east easy eat economic economy edge education effect effort eight either election else employee end energy enjoy enough enter entire environment environmental especially establish even evening event ever every everybody everyone everything evidence exactly example executive exist expect experience expert explain eye face fact factor fail fall family far fast father fear federal feel feeling few field fight figure fill film final finally financial find fine finger finish fire firm first fish five floor fly focus follow food foot for force foreign forget form former forward four free friend from front full fund future game garden gas general generation get girl give glass go goal good government great green ground group grow growth guess gun guy hair half hand hang happen happy hard have he head health hear heart heat heavy help her here herself high him himself his history hit hold home hope hospital hot hotel hour house how however huge human hundred husband idea identify if image imagine impact important improve in include including increase indeed indicate individual industry information inside instead institution interest interesting international interview into investment involve issue it item its itself job join just keep key kid kill kind kitchen know knowledge land language large last late later laugh law lawyer lay lead leader learn least leave left leg legal less let letter level lie life light like likely line list listen little live local long look lose loss lot love low machine magazine main maintain major majority make man manage management manager many market marriage material matter may maybe me mean measure media medical meet meeting member memory mention message method middle might military million mind minute miss mission model modern moment money month more morning most mother mouth move movement movie much music must my myself name nation national natural nature near nearly necessary need network never new news newspaper next nice night no none nor north not note nothing notice now number occur of off offer office officer official often oh oil ok old on once one only onto open operation opportunity option or order organization other others our out outside over own owner",
  "page pain painting paper parent part participant particular particularly partner party pass past patient pattern pay peace people per perform performance perhaps period person personal phone physical pick picture piece place plan plant play player point police policy political politics poor popular population position positive possible power practice prepare present president pressure pretty prevent price private probably problem process produce product production professional professor program project property protect prove provide public pull purpose push put quality question quickly quite race radio raise range rate rather reach read ready real reality realize really reason receive recent recently recognize record red reduce reflect region relate relationship religious remain remember remove report represent republican require research resource respond response responsibility rest result return reveal rich right rise risk road rock role room rule run safe same save say scene school science scientific score sea season seat second section security see seek seem sell send senior sense series serious serve service set seven several shake share she shoot short shot should shoulder show side sign significant similar simple simply since sing single sister sit site situation six size skill skin small smile so social society soldier some somebody someone something sometimes son song soon sort sound source south southern space speak special specific speech spend sport spring staff stage stand standard star start state statement station stay step still stock stop store story strategy street strong structure student study stuff style subject success successful such suddenly suffer suggest summer support sure surface system table take talk task tax teach teacher team technology television tell ten tend term test than thank that the their them themselves then theory there these they thing think third this those though thought thousand threat three through throughout throw thus time to today together tonight too top total tough toward town trade traditional training travel treat treatment tree trial trip trouble true truth try turn type under understand unit until up upon us use usually value various very victim view violence visit voice vote wait walk wall want war watch water way we weapon wear week weight well west western what whatever when where whether which while white who whole whom whose why wide wife will win wind window wish with within without woman wonder word work worker world worry would write writer wrong yard yeah year yes yet you young your yourself",
  "able accept according account achieve activity actor address administration admit adult affect afraid agency agent ago allow analysis ancient announce annual apartment appeal appreciate appropriate approve architect argument arrange arrival artist aside assume atmosphere attempt attend attitude attorney audience average award aware background balance band barely basic basis bear beauty beginning belief belong beneath bike billion bind bird birth blame blind block blow boat bone border boss bottom brain branch brand bread breath bridge brief bright brilliant broad brown brush burn busy button cable calculate calm capacity captain capture carbon cat category celebrate celebrity chain champion channel chapter chart cheap chemical chest chief chip circle classic classroom climate climb clock cloud club coast coat code coffee colleague column combine comfort comfortable command comment commit committee communicate comparison competition complain complete completely complex component computer concept concert conclude conclusion confidence confirm conflict congress connect connection conservative constant construction contact content context contract contrast contribute conversation convert cook cool cooperation copy corner correct council count counter county courage cousin crash crazy cream creative creature credit crew crisis criteria critic critical criticism crop cross crowd crucial cry curious currently curve cycle damage dance danger dangerous deadline dear decline deeply define definitely delay deliver demand deny department depend depression depth deserve desk desire destroy device dialogue diet dig digital dimension direct directly dirty disappear discipline distance distinct distribution district divide division document domestic dominant double doubt downtown dozen draft drama dramatic dress drink driver due dust duty eager earn earth ease eastern edition editor educational effective efficient egg elderly element elsewhere emerge emergency emotion emotional emphasis employ employer empty enemy engage engine engineer enhance enormous ensure entirely entrance episode equal equipment error escape essay essential estimate ethnic evaluate eventually everyday evil evolve exact exam examine excellent except exchange exciting excuse exercise exhibit expand expansion expectation expense expensive explore expose express expression extend extra extreme extremely fabric facility faculty fair faith false familiar famous fan fantasy farm farmer fashion fat fault favor favorite feature fee female fiction fifteen fifty file finance finding fit fix flag flat flight flow flower fly folk following force forest forever formal formula fortune foundation frame framework freedom frequently fresh fruit fuel fully function funny furniture furthermore gain gallery gap gather gender gene generally generous genetic gentle gift given glad global god gold golf grab grade gradually grand grant grass grave gray grocery guarantee guard guest guide guilty habit habits hall handle hate headline hearing height hero hide highlight highly highway hill hire historian historical hole holiday holy honest honor horizon horizons horror horse host household housing hunt hurt ice ideal ignore illegal illness illustrate imagination immediately immigrant implement imply impose impossible impress impression impressive improvement incident income incorporate incredible independent index infection inflation influence inform initial injury inner innocent input insight insist inspire install instance instruction instrument insurance intelligence intend intense intention interaction internal interpret interpretation intervention introduce invest investigate investigation investor invite involved island isolate journal journalist journey judge judgment juice jump junior jury justice justify keep kick king kiss knee knife knock lab label labor lack lady lake landscape lap largely latter launch layer leadership league lean learning leather lecture length lesson liberal library license lifelong lifestyle lifetime lift limit limited link lip liquid literally literature living load loan location lock logic lonely loose lord loud lovely lover lucky lunch luxury mail male mall manner manufacturer map margin mark marketing mass master match mate math maximum meal meaning meanwhile meat mechanism medicine medium mental menu mere merely mess metal meter mile milk mine minister minor minority mirror mix mixture mode moderate modest monitor mood moral moreover motion motor mount mountain mouse murder muscle museum mutual mystery myth naked narrative narrow negative neighbor neighborhood neither nerve nervous net neutral nevertheless newly nobody nod noise nominee normal normally nose novel novels nuclear numerous nurse nut object objective obligation observation observe obtain obvious obviously occasion occasionally ocean odd odds offense offensive ongoing online opening operate opinion opponent oppose opposite orange ordinary organic organize origin original otherwise ought outcome output outstanding overall overcome overlook owe pace pack package pain pair pale palm pan panel pant parking participate partly passage passenger passion patch path patrol pause peak peer penalty pension percent perfect perfectly permanent permission permit personality perspective perspectives persuade phase phenomenon philosophy photo photograph phrase physician physics piano pile pilot pine pink pipe pitch planet plate platform plenty plot plus pocket poem poet poetry pole poll pollution pool pop porch port portion portrait pose possess possibility post pot potato potential pound pour poverty powerful praise pray prayer precisely predict prefer preference pregnant premise presence preserve press presumably prevent previous previously pride priest primarily primary prime prince princess principal principle print prior priority prison prisoner privacy prize procedure proceed producer profession profile profit profound progress prominent promise promote prompt proof proper properly proportion proposal propose prospect protection protein protest proud provider province provision psychological psychology publication publish punishment purchase pure pursue quarter queen quest quick quiet quote rail rain rank rapid rapidly rare rarely rat ratio raw reaction reader reading reasonable recall recipe recommend recovery recruit reduction refer reference reform refugee refuse regard regardless regime regional register regular regularly regulation reinforce reject relation relative relatively relax release relevant relief religion rely remaining remarkable remind remote rent repeat repeatedly replace reply reporter representative reputation request requirement rescue reservation resident resist resistance resolution resolve resort respect rest restaurant restore restriction retain retire retirement revenue review revolution rhythm rice ride rifle ring rip rising rival river roll romantic roof root rope rough round route routine row royal rub ruin rural rush sacred sad safety sake salad salary sale salt sample sand satellite satisfaction satisfy sauce saving scale scandal scared scenario schedule scheme scholar scholarship scientist scope screen script sculpture secret secretary sector seed segment seize select selection senator sensitive sentence separate sequence settle settlement severe sex sexual shade shadow shape sharp sheet shelf shell shelter shift shine ship shirt shock shoe shop shopping shore shortly shout shower shrug shut sick sight signal silence silent silver similarly sin sink sir sky slave sleep slice slide slight slightly slip slow slowly smart smell smoke smooth snap snow soft software soil solar sole solid solution solve somewhat sophisticated soul soup sovereignty spark speaker spectrum speed spell spin spirit spiritual split spokesman spot spread square squeeze stable stair stake stance stare statistics status steady steal steel stick stir stomach stone storm straight strange stranger strategic stream strength stress stretch strike string strip stroke struggle studio stupid submit substance substantial suburb succeed sudden sufficient sugar suicide suit sum sun super supply supporter suppose supposed supreme surgery surprise surprised surprising surround survey survival survive suspect sustain swear sweep sweet swim swing switch symbol symptom tail talent tale tank tap tape target taste tea tear teaspoon technical technique teen teenager telephone telescope temperature temporary tendency tennis tension tent terrible territory terror terrorism terrorist testify testimony testing text thick thin thinking thirty thoroughly threaten threshold throat ticket tie tight timing tiny tip tired tissue title tobacco toe toilet tomato tomorrow tone tongue tool tooth topic toss tour tourist tournament tower toy trace track tradition traffic tragedy trail train transfer transform transformation transition translate translation transportation trap trash treasure treaty trend tribe trick troop truck truly trust tube tune tunnel twelve twenty twice twin typical typically ugly ultimate ultimately unable uncle unique united universal universe university unknown unless unlike unlikely unusual upper urban urge useful user usual vacation valley valuable van variable variation variety vast vegetable vehicle venture version versus vessel veteran via video village violate violent virtually virtue visible vision visitor visual vital volume volunteer vulnerable wage wake warm warn warning wash waste wealth wealthy weather wedding weekend weekly welcome welfare wet wheel whenever whereas whisper wild wildlife willing wine wing winner winter wipe wire wisdom wise withdraw witness wolf wonderful wood wooden working workshop worth wound wrap writing yell yellow yesterday yield youth zone",
  "is was were been being has had does did done doing goes went gone made makes making says said saying gets got getting gave given gives giving takes took taken taking came comes coming knows knew known thinks thought sees saw seen looks looked looking wants wanted needs needed uses used using finds found tells told asks asked asking works worked working seems seemed feels felt tries tried leaves left calls called keeps kept lets begins began begun helps helped shows showed shown hears heard plays played playing runs ran moves moved lives lived living believes believed brings brought happens happened writes wrote written provides provided sits sat stands stood loses lost pays paid meets met includes included continues continued sets learns learned learning changes changed leads led understands understood watches watched follows followed stops stopped creates created speaks spoke spoken reads spends spent grows grew grown opens opened walks walked wins won offers offered remembers remembered loves loved considers considered appears appeared buys bought waits waited serves served dies died sends sent expects expected builds built stays stayed falls fell fallen cuts reaches reached kills killed remains remained suggests suggested raises raised passes passed sells sold requires required reports reported decides decided pulls pulled closed closes turned turns turning broadens broadened broadening enriches enriched enriching improves improved improving encounters encountered encountering explores explored exploring exploring travels traveled traveling travelling enjoys enjoyed enjoying relaxes relaxed relaxing sparks sparked sparking develops developed developing reading readings books ideas stories cultures histories wonders minds pages rooms novels words habits things people years days times ways men women children hands eyes parts places cases points weeks companies systems programs questions governments numbers groups problems facts schools families students countries states hours lines services issues friends kinds rights members types areas results changes levels sides months games heads houses names offices movies doors health persons others ones cities homes jobs cars teachers stores sounds lights trees parents rules pictures studies records sizes markets reasons ends values tests forms prices costs events courses sources products rates terms forces models steps notes plans projects effects spaces roles needs subjects measures lives deaths views objects details colors papers tasks topics units methods stages goals amounts biographies wise wiser wisest greater greatest better best larger largest smaller smallest higher highest longer longest older oldest younger youngest easier easiest harder hardest bigger biggest newer newest earlier latest fewer lower lowest closer stronger strongest quickly slowly easily really finally usually actually simply clearly nearly recently probably certainly especially exactly directly quietly suddenly carefully completely deeply highly fully truly rarely mostly mainly widely largely partly sincerely happily daily lately sadly busy busier busiest fond kindly wonderfully beneficial critical critically scientific scientifically lifelong wonderful horizons broaden enrich encounter imagination particularly biographies fiction novels spark relax journey treasure habit perspectives perspective complex",
  /*CHUNK-END*/
];

const WORDS = new Set(
  WORD_CHUNKS.join(" ")
    .split(/\s+/)
    .filter((word) => word.length > 0),
);

const LETTERS = /^[A-Za-z]+$/;

function isWord(token: string): boolean {
  return WORDS.has(token.toLowerCase());
}

/** Valid split pieces: at least two letters, except the words "a" and "i". */
function isPiece(piece: string): boolean {
  const lower = piece.toLowerCase();
  if (lower.length === 1) return lower === "a" || lower === "i";
  return WORDS.has(lower);
}

/**
 * Split an unknown run-together token into 2 or 3 known words. Prefers the
 * fewest pieces, then the split whose shortest piece is longest
 * ("ofwords" -> "of words"). Returns null when no split is fully covered.
 */
function splitRunTogether(token: string): string[] | null {
  const n = token.length;
  let best: string[] | null = null;
  let bestShortest = 0;
  const consider = (pieces: string[]): void => {
    const shortest = Math.min(...pieces.map((piece) => piece.length));
    if (!best || pieces.length < best.length || (pieces.length === best.length && shortest > bestShortest)) {
      best = pieces;
      bestShortest = shortest;
    }
  };
  for (let i = 1; i < n; i += 1) {
    const head = token.slice(0, i);
    if (!isPiece(head)) continue;
    const tail = token.slice(i);
    if (isPiece(tail)) consider([head, tail]);
  }
  if (best) return best;
  for (let i = 1; i < n - 1; i += 1) {
    const head = token.slice(0, i);
    if (!isPiece(head)) continue;
    for (let j = i + 1; j < n; j += 1) {
      const middle = token.slice(i, j);
      const tail = token.slice(j);
      if (isPiece(middle) && isPiece(tail)) consider([head, middle, tail]);
    }
  }
  return best;
}

interface Token {
  lead: string;
  core: string;
  trail: string;
}

function parseToken(raw: string): Token {
  const match = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/.exec(raw);
  if (!match) return { lead: "", core: raw, trail: "" };
  return { lead: match[1], core: match[2], trail: match[3] };
}

/** Apply both repairs to one line or paragraph of OCR text. */
export function repairOcrSpacing(text: string): string {
  if (WORDS.size === 0 || !/[A-Za-z]/.test(text)) return text;
  const parts = text.split(/( +)/);
  const tokens: string[] = [];
  const spaces: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) tokens.push(parts[index]);
    else spaces.push(parts[index]);
  }

  // Merge "Furtherm ore" style splits: the joined form is a known word and at
  // least one half is not, so real pairs like "a person" stay apart.
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (spaces[index] !== " ") continue;
    const left = parseToken(tokens[index]);
    const right = parseToken(tokens[index + 1]);
    if (left.trail || right.lead) continue;
    if (!LETTERS.test(left.core) || !LETTERS.test(right.core)) continue;
    const joined = left.core + right.core;
    if (!isWord(joined) || (isWord(left.core) && isWord(right.core))) continue;
    tokens.splice(index, 2, left.lead + joined + right.trail);
    spaces.splice(index, 1);
    index -= 1;
  }

  // Split "ofwords" style run-together tokens.
  const repaired = tokens.map((raw) => {
    const token = parseToken(raw);
    const core = token.core;
    if (core.length < 6 || !LETTERS.test(core) || isWord(core)) return raw;
    // Acronyms and camel-case names (JSON, iPhone) are left alone.
    if (core === core.toUpperCase() || /[a-z][A-Z]/.test(core)) return raw;
    const pieces = splitRunTogether(core);
    if (!pieces) return raw;
    const words = pieces.map((piece, index) => (index === 0 ? piece : piece.toLowerCase()));
    return token.lead + words.join(" ") + token.trail;
  });

  let out = repaired[0] ?? "";
  for (let index = 1; index < repaired.length; index += 1) out += spaces[index - 1] + repaired[index];
  return out;
}
