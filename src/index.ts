import { AxiosInstance, AxiosResponse, default as axios } from 'axios';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as Pool from 'generic-pool';
import * as https from 'https';
import * as puppeteer from 'puppeteer';
import { Stream } from 'stream';

const options: puppeteer.LaunchOptions = { headless: true, args: ['--ignore-certificate-errors'] }

const factory: Pool.Factory<puppeteer.Page> = {
    create: async (): Promise<puppeteer.Page> => {
        try {
            const browser = await puppeteer.launch(options)
            let p = await browser.newPage()
            return pageIntercept(p)
        } catch (error) {
            throw Error(error)
        }
    },
    destroy: async (page: puppeteer.Page): Promise<void> => {
        const browser = page.browser()
        try {
            await page.close()
            return browser.close()
        } catch (error) {
            throw Error(error)
        }
    },
    validate: (page: puppeteer.Page | null | undefined): PromiseLike<boolean> => {
        if (page === undefined || page === null) {
            return Promise.resolve(false)
        }
        return Promise.resolve(!page.isClosed())
    }
}


function createHttpsIgnoreClient(): AxiosInstance {
    return axios.create({
        httpsAgent: new https.Agent({
            rejectUnauthorized: false
        })
    })
}

const poolOptions: Pool.Options = {
    max: 8,
    autostart: true,
    testOnBorrow: true,
    softIdleTimeoutMillis: 600000,
    evictionRunIntervalMillis: 180000,
    fifo: true,
    maxWaitingClients: 600,
}

async function MainSearch(pool: Pool.Pool<puppeteer.Page>, start: Date, end: Date): Promise<adjudementMeta[]> {
    const ret: adjudementMeta[] = []
    const pageUrls = await pool.use(async (p) => {
        return initSearch(p, start, end)
    })

    const realLinkPromises: PromiseLike<adjudementMeta>[] = []
    for (const u of pageUrls) {
        const tmpAdjs = await pool.use((page) => {
            return metaCollect(page, u)
        })

        for (const tmpAdj of tmpAdjs) {
            realLinkPromises.push(
                pool.use((page) => {
                    return getRealLink(page, tmpAdj)
                })
            )
        }
    }
    return Promise.all(realLinkPromises)
}

async function pageIntercept(p: puppeteer.Page): Promise<puppeteer.Page> {
    p.setDefaultTimeout(10000)
    await Promise.all([
        p.setRequestInterception(true)
    ])
    p.on('request', (request: puppeteer.Request) => {
        if (request.url().indexOf("https://law.judicial.gov.tw") === -1 ||
            request.resourceType() === 'image' ||
            request.resourceType() === 'stylesheet' ||
            request.resourceType() === 'font') {

            request.abort()
        } else {
            request.continue()
        }
    })

    return p
}

// returns urls for collecting metadatas
async function initSearch(page: puppeteer.Page, start: Date, end: Date): Promise<string[]> {
    const startPageURL: string = "https://law.judicial.gov.tw/FJUD/Default_AD.aspx"
    const selectElement: string = "#jud_court"
    const TPSSelector: string = "#jud_court > option[value=TPS]"
    const chkboxSelector: string = "#vtype_V > input[type=checkbox]"
    const submitSelector: string = '#btnQry'

    return new Promise(async (resolve, reject) => {
        try {
            await Promise.all([
                page.goto(startPageURL),
                page.waitForSelector(TPSSelector),
                page.waitForSelector(selectElement),
                page.waitForSelector(chkboxSelector)
            ])
            await Promise.all([
                // select 最高法院 
                page.select(selectElement, "TPS"),
                // select 民事
                page.click(chkboxSelector),
                // input search dates
                page.evaluate((sy: number, sm: number, sd: number, ey: number, em: number, ed: number): Promise<void> => {
                    function checkTypeAndAssign(queryString: string, value: number): void {
                        let e: HTMLInputElement;
                        let any: Element | null = document.querySelector(queryString);
                        if (any instanceof HTMLInputElement && any !== null) {
                            e = any;
                            e.value = value.toString();
                        } else {
                            throw Error('checkTypeAndAssign error')
                        }
                    }

                    //start day
                    try {
                        checkTypeAndAssign("#dy1", sy);
                        checkTypeAndAssign("#dm1", sm);
                        checkTypeAndAssign("#dd1", sd);

                        // end day
                        checkTypeAndAssign("#dy2", ey);
                        checkTypeAndAssign("#dm2", em);
                        checkTypeAndAssign("#dd2", ed);

                        return Promise.resolve()
                    } catch (error) {
                        return Promise.reject(error)
                    }
                }, start.getFullYear() - 1911, start.getMonth() + 1, start.getDate(),
                    end.getFullYear() - 1911, end.getMonth() + 1, end.getDate()
                )
            ])
            // click submit

            await Promise.all([
                page.click(submitSelector),
                page.waitForNavigation()
            ])

            const frame = page.frames().find((frame) => {
                return frame.url().includes('qryresultlst.aspx')
            })

            if (frame === undefined) {
                throw Error("frame not found")
            }

            const urlPromise = frame.evaluate(() => {
                const element = document.querySelector("#hlLast")
                if (element === null || !(element instanceof HTMLAnchorElement)) {
                    throw Error("could not find #hlLast")
                }

                const anchor = <HTMLAnchorElement>element
                const href = anchor.href

                if (href === '') {
                    throw Error('empty url, got :"' + href.toString() + '"')
                }
                return href
            })


            const last = new URL(await urlPromise)
            const ret: string[] = [];
            const maxIndex = last.searchParams.get('page')
            if (maxIndex === null) {
                throw Error("got no pages")
            }

            const pageCount = parseInt(maxIndex)
            for (let i = 1; i <= pageCount; i++) {
                let ref = last;
                const newParams = new URLSearchParams(last.searchParams)
                newParams.set('page', i.toString())
                ref.search = newParams.toString()
                ret.push(ref.href)
            }
            resolve(ret)
            // click sort
        } catch (error) {
            reject(error)
        }
    });
};


interface adjudementMeta {
    jn: string;
    jdate?: Date,
    jdatestr?: string,
    reason: string,
    link: string,
    size: number,
}

interface content {
    name: string,
    content: string,
    pdf: string
}

// 
async function metaCollect(page: puppeteer.Page, u: string): Promise<adjudementMeta[]> {
    await page.goto(u, { waitUntil: 'domcontentloaded' })
    let list: adjudementMeta[] = []
    const queryStringForTrs: string = '#jud > tbody > tr'
    const _u = page.url();
    const url = _u.substring(0, _u.lastIndexOf("/") + 1)
    let meta: adjudementMeta[]
    try {
        const m: adjudementMeta[] =
            await page.evaluate(function (queryString: string, url: string): adjudementMeta[] {
                const ret: adjudementMeta[] = [];
                let elements: Element[] = Array.from(document.querySelectorAll(queryString))

                // filter out head and summary rows
                elements = elements.filter((v: Element, i: number): boolean => {
                    return Math.abs(i % 2) === 1
                })

                function stringDotToDate(str: string): Date {
                    let nn: number[] = str.split(".").map((s, i) => {
                        if (i === 0) {
                            return parseInt(s) + 1911
                        }
                        return parseInt(s)
                    })
                    return new Date(nn.map((n) => { return n.toString() }).join("-"))
                }

                function getSize(str: string): number {
                    return parseInt(str.substring(str.lastIndexOf("（") + 1, str.lastIndexOf("）"))) * 1024
                }

                for (const e of elements) {
                    const children: Element[] = Array.from(e.children)

                    // there are 4 <td> tags in a row.
                    const jn: string = children[1].children[0].innerHTML
                    const jdate: Date = stringDotToDate(children[2].innerHTML)
                    const size: number = getSize(children[1].innerHTML)
                    const reason: string = children[3].innerHTML.trim()

                    let h: Attr = children[1].children[0].attributes.getNamedItem("href") as Attr
                    let link: string = url + h.value

                    ret.push({
                        jn: jn,
                        jdatestr: jdate.toString(),
                        size: size,
                        reason: reason,
                        link: link
                    })
                }
                return ret

            }, queryStringForTrs, url)
        meta = m
    } catch (error) {
        meta = []
        console.log(error)
    }

    const cleanse = meta.map((m) => {

        const r: adjudementMeta = {
            jn: m.jn,
            jdate: new Date(m.jdatestr as string),
            size: m.size,
            reason: m.reason,
            link: m.link,
        }
        return r
    })

    list.push(...cleanse)
    return list
}


async function getRealLink(page: puppeteer.Page, adj: adjudementMeta): Promise<adjudementMeta> {
    if (adj.link.includes("FJUD/data.aspx") === false) {
        return Promise.reject()
    }
    await page.goto(adj.link, { waitUntil: 'domcontentloaded' })
    await page.click("#hlCopyWeb")
    const inputElement = await page.$("#txtUrl")
    const nl = await page.evaluate((e): Promise<string> => {
        return new Promise(async (resolve, reject) => {
            setTimeout(reject, 300)
            let value: string
            value = e.value.toString()
            if (value === "") {
                reject()
            } else {
                resolve(value)
            }
        })
    }, inputElement)

    adj.link = nl
    return adj
}



function keygen(str: string): string {
    const sha1 = crypto.createHash('sha1')
    sha1.update(str)
    return sha1.digest('hex')
}

// give a temporary or perminent adjudement page, returns pdf url 
// the page must be adjument page
async function getPDFUrl(page: puppeteer.Page): Promise<string> {
    if (!page.url().includes('FJUD/data.aspx')) {
        return Promise.reject(Error('getPDFUrl failed: ' + page.url()))
    }

    const u = new URL(page.url())

    return page.evaluate(() => {
        const e = document.querySelector('#hlExportPDF')
        if (e === null || !(e instanceof HTMLAnchorElement)) {
            throw Error('<a> not found')
        }
        const anchor = <HTMLAnchorElement>e
        const href = anchor.href;
        if (href === undefined) {
            throw Error('empty')
        }
        return href
    })
}

// the page must be adjument page
async function getContent(page: puppeteer.Page): Promise<string> {
    const origin = page.url()
    if (!origin.includes('data.aspx')) {
        throw Error('invalid url: ' + origin)
    }

    // data.aspx page. do not need to navigate
    let text = await page.evaluate(() => {
        const e = document.querySelector('#jud')

        if (e === null || !(e instanceof HTMLDivElement)) {
            throw Error('<div> not found')
        }

        const div = <HTMLDivElement>e
        const text = div.innerText

        return text
    })

    text = getReJDocString(text)

    return text
}


function getReJDocString(input: string) {

    let d = input.split('\n'),
        o: string = '', // output
        term: string,
        // breaks rule
        duelBreaks = (t: string): void => { o += "\n" + t + "\n"; },
        topBreak = (t: string): void => { o += "\n" + t; },
        btmBreak = (t: string): void => { o += t + "\n"; },
        // regexp
        // Content Columns
        regexASCIITable = /[\u2500-\u257F]/g,
        regexNav = /\u5171\d+\s?\u7b46|\u73fe\u5728\u7b2c\d+\s?\u7b46|[\u7b2c\u4e0a\u4e0b\u4e00\u6700\u672b]{2}[\u7b46\u9801]|\u53cb\u5584\u5217\u5370|\u532f\u51faPDF|\u5c0d\u65bc\u672c\u7cfb\u7d71\u529f\u80fd\u6709\u4efb\u4f55\u5efa\u8b70|\u6709\u52a0\u5e95\u7dda\u8005\u70ba\u53ef\u9ede\u9078\u4e4b\u9805\u76ee|\u7121\u683c\u5f0f\u8907\u88fd|\u8acb\u7d66\u4e88\u6211\u5011\u5efa\u8b70|^\u8acb\u9ede\u9019\u88e1\u4e26\u8f38\u5165\u4f60\u7684[\u540d\u5b57\w]+|Olark|\u7559\u4e0b\u4f60\u7684\u5efa\u8b70|^\u641c\u5c0b$|^\u767b\u5165$|^\u9001\u51fa$|\u5206\u4eab\u81f3[\w\s]+|\u6392\u7248\u5716\u793a/,
        regexFormalDate = /^\u4e2d\u83ef\u6c11\u570b.+\u5e74.+\u6708.+\u65e5$/,
        regexTopColumns = /^\u3010|^\u88c1\u5224[\u5b57\u865f\u65e5\u671f\u6848\u7531\u5168\u5167\u6587]+|^\u6703\u8b70\u6b21\u5225|^\u6c7a\u8b70\u65e5\u671f|^\u8cc7\u6599\u4f86\u6e90|^\u76f8\u95dc\u6cd5\u689d|^\u6c7a\u8b70\uff1a|^\u8a0e\u8ad6\u4e8b\u9805\uff1a|\u63d0\u6848\uff1a$|^\u6b77\u5be9\u88c1\u5224|^\u89e3\u91cb[\u5b57\u865f\u65e5\u671f\u722d\u9ede\u6587\u7406\u7531]+/,
        regexBodyColumns = /^[\u4e3b\u6587\u7406\u7531\u72af\u7f6a\u4e8b\u5be6\u53ca\u9644\u8868\u4ef6\u8a3b\u9304\u689d\u6587\u8981\u65e8\uff1a]{2,}$/,
        regexLawArticle = /\u7b2c[\d\u3001\-]+\u689d\([\d\.]+\)$/,
        regexCaseName = /^[\u53f8\u6cd5\u6700\u9ad8\u81fa\u7063\u5317\u4e2d\u9ad8\u96c4\u798f\u5efa\u667a\u6167\u516c\u52d9\u54e1]{2,}.+[\u58f9\u8cb3\u53c1\u53c3\u8086\u4f0d\u9678\u67d2\u634c\u7396\u62fe\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u25CB\d]+\u5e74\u5ea6.+\u5b57\u7b2c[\u58f9\u8cb3\u53c1\u53c3\u8086\u4f0d\u9678\u67d2\u634c\u7396\u62fe\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u25CB\d]+\u865f[\u88c1\u5224\u5b9a\u6c7a]*$/,
        regexParities = /^[\u5148\u5f8c]?\u8a34?[\u539f\u88ab]\u544a|^[\u6cd5\u5b9a\u8a34\u8a1f]*[\u4ee3\u7406\u8868]+\u4eba|^\u79fb\u9001\u6a5f\u95dc|^\u88ab\u4ed8\u61f2\u6212\u4eba|^\u8a34\u9858\u4eba|^\u8072\u8acb\u8986\u5be9\u4eba|^\u8072\u8acb\u4eba|^\u76f8\u5c0d\u4eba|^\u518d?\u6297\u544a\u4eba|^\u88ab?\u4e0a\u8a34\u4eba|^\u50b5[\u52d9\u6b0a]\u4eba|^[\u539f\u5be9\u9078\u4efb]*\u8faf\u8b77\u4eba|^\u516c\u8a34\u4eba|\u5f8b\u5e2b$/,
        regexOfficials = /^.+\u5ead.+[\u6cd5\u5b98\u5be9\u5224\u9577]+|^\u5927?\u6cd5\u5b98|^\u66f8\u8a18\u5b98/,
        // Paragraph Tier
        regexTier1 = /^[\u7532\u4e59\u4e19\u4e01\u620a\u5df1\u5e9a\u8f9b\u58ec\u7678\u5b50\u4e11\u5bc5\u536f\u8fb0\u5df3\u5348\u672a\u7533\u9149\u620c\u4ea5]+[\u3001\u8aaa\uff1a]+/,
        regexTier2 = /^[\u58f9\u8cb3\u53c1\u53c3\u8086\u4f0d\u9678\u67d2\u634c\u7396\u62fe\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u25CB\uFF10-\uFF19]+[\u3001\u8aaa\uff1a]+/,
        regexTier3 = /^[(\uff08][\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u25CB\uFF10-\uFF19]+[\uff09)]/,
        regexTier4 = /^[\d\uFF10-\uFF19]+\.\D/,
        regexTier5 = /^[(\uff08][\d\uFF10-\uFF19]+[)\uff09]\D/,
        // Marks
        regexBlankMarks = /\s+|\u3000/g,
        regexAllMarks = /[\uff0c\u3002\u3001\uff01\uff1f]+/,
        regexSingleMark = /^[\u3002\uff1a\uff1f\uff01]$/,
        regexParagraphMarks = /[\uff0c\u3002\u3001]+/,
        regexFootMarks = /[\u3002\uff1a\uff01\uff1f]$/,
        regexClosureMarks = /[\n\r]+([\u3009\u300b\u300d\u300f\u3011\u3015\u3017\u3019\u301b\uff0c,)\]])/gim,
        regexBreakMarks = /^[\n\r]+/gim,
        regexLineBreak = /\n|\r/gm;

    for (let i = 0; i < d.length; i++) {
        // plain text table: break
        if (regexASCIITable.test(d[i])) { duelBreaks(d[i]); continue; }

        // strip out all blanks
        term = d[i].replace(regexBlankMarks, '').trim();

        // site navigation and informations: delete
        if (regexNav.test(term)) { continue; }

        // if a sentense's content is a single mark: combine
        // if(/(?:^[\u3000-\u303F\uFF00-\uFF65].+[\u3000-\u303F\uFF00-\uFF65]$)/.test(term)){o+=term;continue;}
        if (regexSingleMark.test(term)) { btmBreak(term); continue; }

        // special columns: break
        if (regexFormalDate.test(term) ||
            regexTopColumns.test(term) ||
            regexLawArticle.test(term)
        ) { duelBreaks(term); continue; }

        // special columns: break
        if (!regexParagraphMarks.test(term)) {
            if (regexCaseName.test(term)) { btmBreak(term); continue; }
            if (regexParities.test(term)) { duelBreaks(term); continue; }
            if (regexBodyColumns.test(term)) { duelBreaks(term); continue; }
            if (regexOfficials.test(term)) { duelBreaks(term); continue; }
        }

        // paragraph mark: break
        if (regexTier1.test(term) ||
            regexTier2.test(term) ||
            regexTier3.test(term) ||
            regexTier4.test(term) ||
            regexTier5.test(term)) {

            topBreak(term)
            continue
        }

        // if a sentense has common punctuation marks but not in the foot: combine
        if (regexAllMarks.test(term) && !regexFootMarks.test(term)) { o += term; continue; }
        // if a sentense's foot has general punctuation: break
        if (regexFootMarks.test(term)) { btmBreak(term); continue; }

        // all others: combine
        o += term;
    }
    // if first char is close mark or comma: combie
    o = o.replace(regexClosureMarks, "$1");
    // surplus line breaks: delete
    o = o.replace(regexBreakMarks, '');

    return o;
}


async function buildContent(page: puppeteer.Page, m: adjudementMeta): Promise<content> {
    try {
        await page.goto(m.link)
    } catch (error) {
        throw error
    }
    let c: content = { name: '', content: '', pdf: '' }

    c.name = m.jn
    c.pdf = await getPDFUrl(page)
    c.content = await getContent(page)

    return c
}

async function createDownloadFolder(path: string): Promise<void> {
    try {
        await fsp.mkdir(path, { recursive: true })
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

async function downloadPDF(c: content, client: AxiosInstance, dst: string): Promise<void> {
    if (dst === "") {
        throw Error('folder path not exist')
    }
    let resp: AxiosResponse<Stream>
    try {
        resp = await client({
            url: c.pdf,
            method: 'get',
            responseType: 'stream'
        })
    } catch (error) {
        throw Error('fetch error')
    }

    const writer = fs.createWriteStream(dst + '/' + c.name + '.pdf')

    resp.data.pipe(writer)
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
    })
}


async function downloadTxt(c: content, dst: string): Promise<void> {
    if (dst === "") {
        throw Error('folder path not exist')
    }
    const filename = dst + "/" + c.name + ".txt"
    const writer = await fsp.open(filename, "w")
    await writer.writeFile(c.content)
    return writer.close()
}



export async function cliFunc(start: Date, end: Date, folderPath: string): Promise<void> {
    const pool = Pool.createPool(
        factory,
        poolOptions
    )

    const client = createHttpsIgnoreClient()
    const donePrs: Promise<any>[] = []

    try {
        await createDownloadFolder(folderPath)
    } catch (error) {
        throw Error('could not create download folder. program stopped.')
    }

    try {
        const meta = await MainSearch(pool, start, end)
        for (const m of meta) {
            donePrs.push(
                Promise.resolve(
                    pool.use((page) => {
                        return buildContent(page, m)
                    })
                ).then((content) => {
                    return Promise.all([
                        downloadPDF(content, client, folderPath),
                        downloadTxt(content, folderPath)
                    ])
                })
            )
        }
    } catch (error) {
        console.error(error)
        await pool.drain()
        await pool.clear()
        throw Error(error)
    }

    try {
        await Promise.all(donePrs)
    } finally {
        await pool.drain()
        await pool.clear()
    }
}

