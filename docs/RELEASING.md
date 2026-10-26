# npm 배포

패키지는 `@ohah/heic`, 레지스트리는 `https://registry.npmjs.org/`입니다. 배포 워크플로는 `.github/workflows/release.yml`입니다.

## 인증과 GitHub 환경

- GitHub 저장소의 `npm` 환경에 `NPM_TOKEN` Secret을 등록합니다. `ohah/zntc`의 배포 변수명을 참고했습니다.
- 토큰은 해당 패키지의 배포 권한이 있어야 합니다. 토큰 값은 코드·문서·로그에 넣지 않습니다.
- 환경의 배포 허용 대상은 `main` 브랜치와 `v*` 태그입니다.
- `actions/setup-node`가 구성한 npm 인증 파일에서 `NODE_AUTH_TOKEN`으로 Secret을 사용합니다. 의존성 설치·빌드는 인증값 없는 별도 작업에서 실행합니다.
- 실제 배포 작업에만 `id-token: write`를 부여해 provenance를 생성합니다. 현재 인증은 `NPM_TOKEN` 방식입니다. OIDC trusted publisher 전용 인증으로 전환하려면 npm 패키지 설정에 저장소·워크플로·환경을 별도로 등록해야 합니다.

## 실제 배포 전 검증

GitHub Actions에서 **npm Release → Run workflow → main**을 선택하고 `dry_run`을 기본값 `true`로 실행합니다.

1. 잠금 파일로 개발 의존성을 설치합니다.
2. 린트·포맷·타입 검사, 테스트와 빌드를 실행합니다.
3. `npm pack`으로 만든 압축 파일에서 진입점·타입·라이선스·NOTICE와 파일 허용 목록을 검사합니다. 원본 이미지·테스트·인증 파일은 패키지에 포함하지 않습니다.
4. 검증한 압축 파일을 작업 간 artifact로 전달합니다.
5. `npm` 환경의 토큰으로 `npm whoami`를 확인합니다.
6. 같은 압축 파일로 `npm publish --dry-run`을 실행합니다. 이 실행은 실제 npm 버전을 생성하지 않습니다.

토큰의 인증 성공이나 dry-run 성공은 첫 실제 배포의 패키지 쓰기 권한까지 보장하지 않습니다. 실제 배포에서 권한·2FA 정책 오류가 나면 npm 토큰의 해당 패키지 권한과 배포 정책을 확인합니다.

## 버전 배포

1. 패키지 버전을 변경한 PR을 머지합니다.
2. 최신 `main`에 해당 버전의 태그를 생성합니다. 예를 들어 버전이 `0.1.0`이면 태그는 `v0.1.0`이어야 합니다.
3. 태그를 push하면 검증과 npm 배포가 실행됩니다.
4. 안정 버전은 `latest`, 사전 버전은 `next` dist-tag로 배포합니다.
5. 워크플로 결과와 npm에 등록된 버전·provenance를 확인합니다. `npm view @ohah/heic@<버전> version`과 새 디렉터리의 설치·디코딩 검증까지 통과해야 공개 완료로 판단합니다.

태그 버전과 `package.json` 버전이 다르거나 태그의 커밋이 `main`에 포함되지 않으면 실패합니다. 수동 실행에서도 `dry_run: false`를 선택하면 실제 배포하므로 사전 검증과 구분합니다. 이미 배포한 버전은 다시 배포하지 않습니다.

이 설정 작업 자체는 첫 npm 버전을 배포하지 않습니다. 지원 범위와 미지원 기능은 README와 검증 기록을 확인합니다.

## 제출 성공과 실제 공개 구분

npm은 제출 직후 패키지를 검사해 설치 가능 시점이 늦어질 수 있습니다. CLI의 성공 메시지만으로 설치까지 완료됐다고 보고하지 않습니다. 메타데이터와 tarball 다운로드 가능 여부를 각각 확인하고, 대기 중 같은 버전을 중복 제출하지 않습니다.

`0.0.0-stage` 임시 버전 표시만으로 사용자 승인 대기를 단정하지 않습니다. 실제 Staged Packages 목록이 있는지 확인해야 합니다. `0.1.0` 첫 배포에서는 사용자 승인 없이 잠시 뒤 정상 버전과 tarball이 공개됐습니다.

공식 안내: https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/
