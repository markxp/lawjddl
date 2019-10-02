
export function Reformat(input: string): string {
    let text: string = input
    let current: string = ""
    let ret: string = ""

    text = text
        .replace(/\r|\r\n|\n/g, '\n')
        .replace(/[\uFF0c\uFE10\uFE50]/g, '，')
        .replace(/[ \u3000]/g, '')
        .replace(/[\n]{2,}/g, '')

    // part 1
    let sentinal: number[] = []
    sentinal.push(text.indexOf("聲請人"), text.indexOf("抗告人"), text.indexOf("再抗告人"))
    sentinal = sentinal.filter((s) => {
        return s > 0
    })

    let idx = Math.min(...sentinal)


    current = text.substring(0, idx)
    text = text.substring(idx)

    current = current.replace(/(.+)：\n(.+)\n/g, '【$1】 $2\n')
    current = current.split('\n').filter((v) => {
        return v.includes("【")
    }).join('\n')

    ret += current
    ret = ret + "\n\n"

    // part 2
    // 兩造
    let sentences: string[] = []
    let n: number = 0
    sentences = text.split('\n')
    n = sentences.findIndex((value) => {
        return value.includes("上列")
    })

    n = sentences.filter((_, i) => {
        return i < n
    }).join('\n').length

    current = text.substring(0, n)
    text = text.substring(n)

    current = current
        .replace(/共同\n(.{2,8}人)/, '共同$1')
        .replace(/(.{2,8}人)(.{2,50})/g, '【$1】 $2\n')
        .replace(/(【.+)(\n([^【]+))+/g, '$1 $3')

    ret += current
    ret += '\n'

    // part 3 
    // 案情提要
    sentences = text.split('\n')
    n = sentences.findIndex((v) => {
        let re = /本院.+：/
        return re.test(v)
    })

    n = sentences.filter((v, i) => {
        return i <= n
    }).join('\n').length

    current = text.substring(0, n)
    text = text.substring(n)

    current = current.replace(/(.+)。\n/g, '$1。\n\n')
    current = addSpacesBetweenNumbersAndEnglish(current)
    current = removeUnwantedEOL(current)

    ret += current
    ret += '\n'

    // part 4 
    // 主文
    sentences = text.split('\n')
    n = sentences.findIndex((str) => {
        return str.includes("理由")
    }) - 1

    n = sentences.filter((_, i) => {
        return i <= n
    }).join('\n').length

    current = text.substring(0, n)
    text = text.substring(n)

    current = current.replace(/(主文)/, '【$1】')
    sentences = current.split('\n')
    current = sentences[0] + "\n" + sentences.filter((_, i) => {
        return i > 0
    }).join("\n- ")

    ret += current
    ret += '\n'

    // part 5
    // 長長的內文 
    n = text.indexOf("裁定如主文。") + 6
    current = text.substring(0, n)
    text = text.substring(n)

    current = removeUnwantedEOL(current)
    current = addSpacesBetweenNumbersAndEnglish(current)
    current = current
        .replace(/(.+)。\n/g, '$1。\n\n')
        .replace(/(理由)/, '【$1】\n')

    ret += current
    ret += '\n'

    // part 6
    // 法官
    current = text
    text = ''

    // empty line at line 0,
    // jdate at line 1
    current = current.split('\n').filter((_, i) => {
        return i > 1
    }).join('\n')

    current = "\n" + current
    current = current
        .replace(/^(.{0,})(法官)(.+)$/mg, '【$1$2】 $3')

    current = addSpacesBetweenNumbersAndEnglish(current)
    ret += current
    return ret
}

function addSpacesBetweenNumbersAndEnglish(str: string): string {
    return str
        .replace(/([\u4E00-\u9FCC\u3400-\u4DB5\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uFA27-\uFA29]|[\ud840-\ud868][\udc00-\udfff]|\ud869[\udc00-\uded6\udf00-\udfff]|[\ud86a-\ud86c][\udc00-\udfff]|\ud86d[\udc00-\udf34\udf40-\udfff]|\ud86e[\udc00-\udc1d]|[\u3001\u3003-\u303F\u0028\u0029（）])([\.\w○]+)/g, '$1 $2')
        .replace(/([\.\w○]+)([\u4E00-\u9FCC\u3400-\u4DB5\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uFA27-\uFA29]|[\ud840-\ud868][\udc00-\udfff]|\ud869[\udc00-\uded6\udf00-\udfff]|[\ud86a-\ud86c][\udc00-\udfff]|\ud86d[\udc00-\udf34\udf40-\udfff]|\ud86e[\udc00-\udc1d]|[\u3001\u3003-\u303F\u0028\u0029（）])/g, '$1 $2')
}

function removeUnwantedEOL(str: string): string {
    return str
        .replace(/。\n/g, '。&sEOL&')
        .replace(/([\w]|[\u4E00-\u9FCC\u3400-\u4DB5\uFA0E\uFA0F\uFA11\uFA13\uFA14\uFA1F\uFA21\uFA23\uFA24\uFA27-\uFA29]|[\ud840-\ud868][\udc00-\udfff]|\ud869[\udc00-\uded6\udf00-\udfff]|[\ud86a-\ud86c][\udc00-\udfff]|\ud86d[\udc00-\udf34\udf40-\udfff]|\ud86e[\udc00-\udc1d]|[（）：、，]|○+)\r|\r\n|\n/g, '$1')
        .replace(/&sEOL&/g, '\n')
}

function TestReformat() {
    let input = `裁判字號：
    最高法院 108 年台抗字第 487 號民事裁定
    裁判日期：
    民國 108 年 07 月 10 日
    裁判案由：
    聲請拍賣抵押物強制執行
    最高法院民事裁定　　　　　　　　　　108年度台抗字第487號
    再 抗告 人　鄭鴻滄
    　　　　　　鄭鴻忠
    共同代理人　李秉哲律師
    上列再抗告人因與高秀英間聲請拍賣抵押物強制執行事件，對於
    中華民國108年2月13日臺灣高等法院臺中分院裁定（108 年度抗
    字第10號），提起再抗告，本院裁定如下：
        主  文
    再抗告駁回。                                            
    再抗告程序費用由再抗告人負擔。
        理  由
    本件相對人高秀英持拍賣抵押物裁定為執行名義，聲請臺灣苗栗
    地方法院（下稱苗栗地院）以106年度司執字第19827號強制執行
    事件拍賣再抗告人信託登記予債務人李美蓉名下坐落於苗栗縣竹
    南鎮○○段000○000○0○000○0 ○地號土地（下稱系爭土地）
    ，經二次減價而未拍定，由相對人以原定拍賣價格新臺幣（下同
    ）1,395萬2,000元依法承受，並陳報抵押債權6筆共1,157萬8,93
    5 元予以抵繳，因債權人僅相對人一人，執行法院乃列計相對人
    尚有367萬2,018元未受償之債權計算書，通知兩造表示意見。再
    抗告人以已償還相對人987萬3,200元，相對人未歸還本票，重複
    計算債權金額，其承受系爭土地，應再支付620萬1,182元為由，
    聲明異議。經該院司法事務官駁回後，復提出異議，亦經該院裁
    定駁回。再抗告人不服，提起抗告。原法院以：強制執行法第12
    條第1 項之聲明異議，係對違法執行程序所為之救濟，至於實體
    上權利義務之爭執，執行法院並無審認之權。再抗告人異議爭執
    事由，屬兩造實體上權利義務之問題，應另循民事訴訟程序謀求
    救濟，因而裁定維持苗栗地院所為駁回再抗告人聲明異議之裁定
    ，裁定駁回其抗告。經核於法並無違誤。再抗告人以相對人所提
    6 紙本票未經本票裁定程序，形式上執行名義有瑕疵，原裁定認
    係非程序上之事項，不得異議，不無違誤云云，提起再抗告。惟
    查相對人係以拍賣抵押物裁定為執行名義，聲請拍賣系爭土地，
    嗣執行法院通知其應提出強制執行法第6條第1項第5 款規定之證
    明文件後，始補送6紙本票為抵押債權之證明（見一審卷第19、3
    9 頁），並非以該等本票為執行名義。再抗告人上開主張，為無
    可採。再抗告意旨，指摘原裁定違背法令，聲明廢棄，非有理由
    。
    據上論結，本件再抗告為無理由。依強制執行法第30條之1 ，民
    事訴訟法第495條之1第2項、第481條、第449條第1項、第95條、
    第78條，裁定如主文。
    中    華    民    國   108    年    7     月    10    日
                          最高法院民事第二庭
                              審判長法官  陳  重  瑜  
                                    法官  吳  謀  焰  
                                    法官  陳  駿  璧  
                                    法官  周  舒  雁  
                                    法官  吳  青  蓉  
    本件正本證明與原本無異
                                          書  記  官 
    中    華    民    國   108    年    7     月    22    日
    
    
    
    `

    console.log(Reformat(input))
}
