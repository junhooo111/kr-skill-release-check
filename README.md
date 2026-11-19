# kr-skill-release-check

스킬이나 레포를 GitHub에 공개하기 전에 기밀과 개인정보가 섞였는지, 공개 준비가 됐는지 점검하는 Claude 스킬입니다. 한국 개발자를 위해 만들었습니다.

점검만 하고 고치지는 않습니다. 파일 수정, 커밋, 푸시는 하지 않습니다.

## 무엇을 점검하나

- 한국식 개인정보: 주민등록번호 형태, 휴대전화, 사업자등록번호 형태
- 키와 토큰: OpenAI, Google, GitHub, AWS, Slack 형태, 개인 키 블록
- 내부 주소: 사설 IP, 사내 도메인, 공유 폴더 경로, 사용자 이름이 들어간 로컬 경로
- 내가 직접 적은 사전: 회사명, 고객사, 프로젝트 코드명, 동료 이름
- git 이력: 커밋 작성자 이메일, 이력에 남은 비밀 값
- 구조: `SKILL.md` 프런트매터, LICENSE, README, 출처 표기

## 요구 사항

Node 18 이상(점검 스크립트 `scripts/scan.mjs`용), git(이력 점검용). PDF 본문까지 보려면 `pdftotext`(poppler) 또는 `mutool`이 필요합니다. 없으면 PDF는 "읽지 못함"으로 보고됩니다.

## 설치

```bash
npx skills add junhooo111/kr-skill-release-check
```

또는 이 폴더를 `~/.claude/skills/kr-skill-release-check/`에 복사합니다.

## 사용

공개하려는 폴더에서 Claude Code를 열고 이렇게 말합니다.

- "공개해도 돼? 점검해줘"
- "올리기 전에 기밀 들어갔는지 봐줘"

점검은 `scripts/scan.mjs`가 하며 값은 가려서 위치와 건수만 보여 줍니다. 직접 돌려 볼 수도 있습니다.

```bash
node scripts/scan.mjs <점검할 폴더> [--terms=사전파일] [--no-history]

# 오탐이 뻔한 경로 제외 (여러 번 가능). 대상 폴더의 .release-check-ignore 파일에 한 줄씩 적어도 됩니다
node scripts/scan.mjs <점검할 폴더> --ignore=scripts/rules.mjs --ignore=".claude/skills/**"

# 비밀 값이 든 파일을 값은 가린 채 보고 싶을 때
node scripts/scan.mjs <점검할 폴더> --redact-view=SKILL.md
```

처음에는 공개하면 안 되는 단어(회사명, 고객사 등)가 있는지 묻습니다. 답하면 `~/.claude/kr-skill-release-check/private-terms.txt`에 저장할지 물어봅니다. 이 파일은 공개 레포에 올리지 마세요.

## 한계

- 규칙과 내 사전에 없는 기밀은 찾지 못합니다.
- 이미지 속 글자는 읽지 못합니다(PDF 본문은 pdftotext가 있을 때만 읽습니다). 직접 확인하세요.
- 제외한 경로는 점검하지 않으므로, 오탐이 확실한 곳에만 쓰세요.
- 통과해도 안전하다는 보증이 아닙니다.
- 정규식은 오탐이 있을 수 있어서 `warn` 항목은 사람이 판단해야 합니다.

## 라이선스

MIT
