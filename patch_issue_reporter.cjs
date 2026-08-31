const fs = require('fs');
const file = 'src/vs/workbench/contrib/issue/browser/issueReporterPage.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(
  "const sendExtensionData = escape(localize('sendExtensionData', \"Include additional extension info\"));",
  `const sendExtensionData = escape(localize('sendExtensionData', "Include additional extension info"));
const toggleSystemInfoLabel = escape(localize('toggleSystemInfo', "Toggle system information"));
const toggleProcessInfoLabel = escape(localize('toggleProcessInfo', "Toggle currently running processes"));
const toggleWorkspaceInfoLabel = escape(localize('toggleWorkspaceInfo', "Toggle workspace metadata"));
const toggleExtensionsLabel = escape(localize('toggleExtensions', "Toggle enabled extensions"));
const toggleExperimentsLabel = escape(localize('toggleExperiments', "Toggle A/B experiment info"));
const toggleExtensionDataLabel = escape(localize('toggleExtensionData', "Toggle additional extension info"));`
);

content = content.replace(
  `<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0 id="extension-id">`,
  `<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleExtensionDataLabel}" tabIndex=0 id="extension-id">`
);

content = content.replace(
  `<label class="caption" for="includeSystemInfo">
				\${sendSystemInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0>`,
  `<label class="caption" for="includeSystemInfo">
				\${sendSystemInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleSystemInfoLabel}" tabIndex=0>`
);

content = content.replace(
  `<label class="caption" for="includeProcessInfo">
				\${sendProcessInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0>`,
  `<label class="caption" for="includeProcessInfo">
				\${sendProcessInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleProcessInfoLabel}" tabIndex=0>`
);

content = content.replace(
  `<label class="caption" for="includeWorkspaceInfo">
				\${sendWorkspaceInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0>`,
  `<label class="caption" for="includeWorkspaceInfo">
				\${sendWorkspaceInfoLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleWorkspaceInfoLabel}" tabIndex=0>`
);

content = content.replace(
  `<label class="caption" for="includeExtensions">
				\${sendExtensionsLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0>`,
  `<label class="caption" for="includeExtensions">
				\${sendExtensionsLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleExtensionsLabel}" tabIndex=0>`
);

content = content.replace(
  `<label class="caption" for="includeExperiments">
				\${sendExperimentsLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" tabIndex=0>`,
  `<label class="caption" for="includeExperiments">
				\${sendExperimentsLabel}
				(<a href="#" class="showInfo" role="button" aria-expanded="false" aria-label="\${toggleExperimentsLabel}" tabIndex=0>`
);

fs.writeFileSync(file, content);
