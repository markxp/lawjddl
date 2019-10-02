import * as fontkit from '@pdf-lib/fontkit';
import { AxiosInstance, AxiosResponse, default as axios } from 'axios';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as Pool from 'generic-pool';
import * as https from 'https';
import { PageSizes, PDFDocument, PDFPage } from 'pdf-lib';
import * as puppeteer from 'puppeteer';
import { TimeoutError } from 'puppeteer/Errors';
import { Stream } from 'stream';
import { Reformat } from './rejdoc';


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

// give a temporary or perminent adjudement page, returns pdf url 
// the page must be adjument page
async function getPDFUrl(page: puppeteer.Page): Promise<string> {
    const origin = page.url()
    if (!origin.includes('data.aspx')) {
        throw Error('invalid url: ' + origin)
    }

    return page.evaluate(() => {
        const e = document.querySelector('#hlExportPDF')
        if (e === null || !(e instanceof HTMLAnchorElement)) {
            throw Error('<a> not found')
        }
        const anchor = <HTMLAnchorElement>e

        return anchor.href || ""
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
    return text
}

async function buildContent(page: puppeteer.Page, m: adjudementMeta): Promise<content> {
    const createContent = (): content => {
        return { name: '', content: '', pdf: '' }
    }

    try {
        await page.goto(m.link)
    } catch (error) {
        if (error instanceof TimeoutError) {
            return createContent()
        }
        console.error(error)
        return createContent()
    }

    try {
        let c = createContent()
        c.name = m.jn
        c.pdf = await getPDFUrl(page)
        c.content = Reformat(await getContent(page))

        return c
    } catch (error) {
        throw Error(error)
    }
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

function readFont(fontFilePath: string): Buffer {
    return fs.readFileSync(fontFilePath)
}

const notoCJKFontBytes = readFont(__dirname + "/../fonts/NotoSansCJKtc-Regular.otf")

async function createPDFfromContent(c: content, dst: string): Promise<void> {
    if (c.name === "" || c.content === "") {
        return
    }

    const doc = await PDFDocument.create()
    if (dst === "") {
        throw Error('folder path not exist')
    }

    doc.registerFontkit(fontkit)


    const createPage = (doc: PDFDocument): PDFPage => {
        const page = doc.addPage(pagesize)
        page.setFont(notoCJKFont)
        page.setFontSize(fontSize)
        return page
    }
    // constants in a document
    const contentStr = c.content
    const notoCJKFont = await doc.embedFont(notoCJKFontBytes)
    const fontSize = 12
    // page 
    const pagesize = PageSizes.A4

    // deriatived values
    const [wordWidth, wordHeight] = [notoCJKFont.widthOfTextAtSize("\u3000", fontSize), notoCJKFont.heightAtSize(fontSize)]

    const wordsPerLine = (pagesize[0] - 100) / wordWidth
    const linesPerPage = (pagesize[1] - 180) / wordHeight

    // split and warp content
    const sentences = splitToArray(contentStr, wordsPerLine)
    // first page
    let page = createPage(doc)

    let lineNum: number = 1
    while (sentences.length > 0) {
        page.drawText(sentences.shift() || "", {
            x: 50,
            y: pagesize[1] - 60 - lineNum * wordHeight,
        })
        lineNum += 1
        if (lineNum >= linesPerPage) {
            page = createPage(doc)
            lineNum = 1
            continue
        }
    }

    const pdfBytes = Buffer.from(await doc.save())

    fs.writeFileSync(dst + '/' + c.name + '.pdf', pdfBytes)
    return Promise.resolve()
}

function splitToArray(str: string, limit: number): string[] {
    const init = str.split("\n")
    const ret: string[] = []
    for (let sentence of init) {
        while (sentence.length >= limit) {
            ret.push(sentence.slice(0, limit - 1))
            sentence = sentence.slice(limit)
        }
        // sentence.length < limit
        ret.push(sentence)
    }
    return ret
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
    if (c.name === "" || c.content === "") {
        return
    }
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
                        createPDFfromContent(content, folderPath),
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
