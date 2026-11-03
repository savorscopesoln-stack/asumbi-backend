/* Phase 15 regression suite. Run with: node tests/run-all.js
   (or `npm test` from backend/, see package.json).

   No live SQL Server is reachable in this environment, so every test
   here runs the real controller/utility code against a mocked
   mssql-pool (tests/helpers/mockPool.js) rather than a live database.
   That verifies logic, query shape, and response behavior faithfully,
   but it is NOT a substitute for running this once against a real
   staging database — see the manual checklist in tests/README.md for
   what still needs that. */
const { summarize } = require("./helpers/tinytest");

require("./mainExamCrud.test.js");
require("./scheduling.test.js");
require("./scheduler.test.js");
require("./studentDashboard.test.js");
require("./reportExport.test.js");
require("./regression.test.js");
require("./walletLedger.test.js");
require("./walletController.test.js");
require("./financeInvoicing.test.js");
require("./tenantControl.test.js");
require("./customInvoice.test.js");
require("./aiMarkingLedger.test.js");
require("./aiMarkingFinance.test.js");
require("./aiMarkingSchemaFile.test.js");
require("./aiMarkingTeacher.test.js");
require("./deviceAccess.test.js");
require("./sebConfigFile.test.js");
require("./examAccess.test.js");
require("./submitQueue.test.js");
require("./examAutosaveLock.test.js");
require("./examClock.test.js");
require("./sebRestriction.test.js");
require("./eAssessmentAttendance.test.js");
require("./assignTeachersBulk.test.js");
require("./assignmentEngine.test.js");
require("./aiMarkingJobs.test.js");
require("./aiMarkingEngine.test.js");
require("./aiMarkingWorker.test.js");
require("./tenantModules.test.js");
require("./tenantPageAccess.test.js");
require("./financeAccount.test.js");
require("./lmsSchema.test.js");
require("./lmsPermissions.test.js");
require("./lmsSettings.test.js");
require("./lmsFoundation.test.js");
require("./lmsIsolation.test.js");
require("./lmsCourses.test.js");
require("./lmsCourseParts.test.js");
require("./lmsEnrolment.test.js");
require("./lmsCourseCopy.test.js");
require("./lmsApproval.test.js");
require("./lmsMyCourses.test.js");
require("./lmsLessons.test.js");
require("./lmsMedia.test.js");
require("./lmsLessonVersions.test.js");
require("./lmsProgress.test.js");
require("./lmsPrerequisites.test.js");
require("./lmsOutcomes.test.js");
require("./lmsAnnouncements.test.js");
require("./lmsNotifications.test.js");
require("./lmsPlanner.test.js");
require("./lmsDashboard.test.js");
require("./lmsCalendarFeed.test.js");
require("./lmsAssignments.test.js");
require("./lmsSubmissions.test.js");
require("./lmsRubrics.test.js");
require("./lmsRelease.test.js");
require("./lmsExtensions.test.js");
require("./lmsQuizMarking.test.js");
require("./lmsQuestionCsv.test.js");
require("./lmsQuestionBank.test.js");
require("./lmsQuizzes.test.js");
require("./lmsQuizAttempts.test.js");
require("./lmsQuizGrading.test.js");
require("./lmsQuizRules.test.js");
require("./lmsPracticeModes.test.js");
require("./lmsFlashcards.test.js");
require("./lmsResultsAdapter.test.js");
require("./lmsQuizAnalytics.test.js");
require("./lmsGradeCalc.test.js");
require("./lmsGradebook.test.js");
require("./lmsGradebookLinks.test.js");
require("./lmsGradeView.test.js");
require("./lmsGradebookExport.test.js");
require("./lmsGradebookResults.test.js");
require("./lmsCertificates.test.js");
require("./lmsBadges.test.js");
require("./lmsReports.test.js");
require("./lmsReports2.test.js");
require("./lmsDiscussions.test.js");
require("./lmsDiscussionMod.test.js");
require("./lmsDiscussionNotices.test.js");
require("./lmsGroups.test.js");
require("./lmsGroupForums.test.js");
require("./lmsPeerReview.test.js");
require("./lmsPeerReviewLearner.test.js");
require("./lmsHelp.test.js");
require("./lmsAnalytics.test.js");
require("./lmsDashboards.test.js");
require("./lmsModeration.test.js");
require("./lmsPaths.test.js");
require("./lmsGuardian.test.js");
require("./lmsOfflinePacks.test.js");
require("./lmsOfflinePackFiles.test.js");
require("./lmsOfflineSync.test.js");
require("./lmsOfflineDrafts.test.js");
require("./lmsOfflineQuiz.test.js");
require("./lmsOfflineRetention.test.js");
require("./lmsPathLearners.test.js");
require("./lmsCompetency.test.js");
require("./lmsGroupAssignments.test.js");
require("./lmsGroupMarking.test.js");
require("./lmsMarking.test.js");
require("./aiMarkingReview.test.js");
require("./aiReviewHelpers.test.js");
require("./aiMarkingScheme.test.js");
require("./aiMarkingCalibration.test.js");
require("./aiMarkingAnalytics.test.js");
require("./aiMarkingSecurity.test.js");
require("./indexSpecs.test.js");
require("./notificationsArchive.test.js");

// If any test promise never settles, Node's event loop simply empties and the
// process exits with code 0 and NO summary — a silent false pass. Detect it.
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("\nFAIL: the run ended before every test settled (a test promise never resolved).");
    process.exitCode = 1;
  }
});

(async () => {
  const ok = await summarize();
  finished = true;
  process.exit(ok ? 0 : 1);
})();
